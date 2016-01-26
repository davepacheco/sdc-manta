#!/usr/bin/env node
/* vim: set ft=javascript: */
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * manta-oneach: execute a shell command on all Manta zones, or a subset of
 * zones using filters based on zonename, service name, or compute node.
 * See usage message for details.
 */

var assert = require('assert');
var bunyan = require('bunyan');
var cmdln = require('cmdln');
var cmdutil = require('cmdutil');
var forkexec = require('forkexec');
var getopt = require('posix-getopt');
var jsprim = require('jsprim');
var path = require('path');
var util = require('util');
var vasync = require('vasync');
var VError = require('verror').VError;

var common = require('../lib/common');
var sdc = require('../lib/sdc');
var madm = require('../lib/adm');
var oneach = require('../lib/oneach');

var mzArg0 = path.basename(process.argv[1]);

var mzSynopses = [
    'SCOPE_ARGUMENTS [OPTIONS] OPERATION_ARGUMENTS'
];

var mzUsageMessage = [
    '',
    'Execute a shell command on all Manta zones or a subset of zones using ',
    'filters based on zonename, service name, or compute node.',
    '',
    'SCOPE ARGUMENTS',
    '',
    '    -a | --all-zones                     all non-marlin, non-global zones',
    '    -S | --compute-node HOSTNAME|UUID... zones on named compute node',
    '    -s | --service SERVICE...            zones of SAPI service SERVICE',
    '    -z | --zonename ZONENAME...          specified zones only',
    '    -G | --global-zones                  operate on global zones of ',
    '                                         whichever zones would otherwise',
    '                                         have been operated on',
    '',
    'OPERATION ARGUMENTS',
    '',
    '    Command execution: OPERATION_ARGUMENTS consists of a single string ',
    '    argument containing an arbitrary bash script to execute in each zone.',
    '',
    '    File transfer: Either the -p/--put or -g/--get option must be ',
    '    specified, plus the -d/--dir option.  The -X/--clobber option may ',
    '    also be used.',
    '',
    '    -g | --get FILE                      causes the remote target to ',
    '                                         fetch the local file FILE ',
    '                                         into the remote directory ',
    '                                         specified with --dir.',
    '',
    '    -p | --put FILE                      causes the remote target to ',
    '                                         upload the remote file FILE ',
    '                                         into the local directory ',
    '                                         specified with --dir.',
    '',
    '    -d | --dir DIR                       see --get and --put',
    '',
    '    -X | --clobber                       allow --get to overwrite an',
    '                                         existing local file.',
    '',
    'OTHER OPTIONS',
    '',
    '    -c | --concurrency N                 number of operations to allow ',
    '                                         outstanding at any given time',
    '',
    '    -I | --immediate                     emit results as they arrive, ',
    '                                         rather than sorted at the end',
    '',
    '    -J | --jsonstream                    emit newline-separated JSON',
    '                                         output, similar to ',
    '                                         sdc-oneachnode(1), but with ',
    '                                         additional "zonename" and ',
    '                                         "service" properties (unless ',
    '                                         --global-zones was specified).',
    '                                         Implies --immediate.',
    '',
    '    -n | --dry-run                       report what would be executed ',
    '                                         without actually running it',
    '',
    '    -N | --oneline                       report only the last line of ',
    '                                         output from each command',
    '',
    '    -T | --exectimeout SECONDS           command execution timeout',
    '                                         (same as for sdc-oneachnode(1))',
    '                                         default: 60 seconds',
    '',
    '    --amqp-host HOST                     AMQP connection parameters',
    '    --amqp-port TCP_PORT                 default: auto-configured',
    '    --amqp-login LOGIN',
    '    --amqp-password PASSWORD',
    '    --amqp-timeout SECONDS               default: 5 seconds',
    '',
    'You must specify either -a/--all-zones or at least one of the other',
    'scope arguments.  -a/--all-zones cannot be combined with the other',
    'arguments.  The other arguments can be combined, and the result is to',
    'operate on zones matching all of the specified criteria.  For example:',
    '',
    '    manta-oneach --compute-node MS08214 --service storage COMMAND',
    '',
    'executes COMMAND on on all "storage" zones on compute node MS08214.',
    '',
    'You can use --global-zones to operate on the global zones hosting ',
    'the zones that would otherwise have been matched.  For example:',
    '',
    '    manta-oneach --global-zones --service=webapi COMMAND',
    '',
    'executes COMMAND in the global zones of all compute nodes containing at ',
    'least one "webapi" zone.'
].join('\n');

/*
 * The short option letters for the AMQP options are not documented and not
 * intended to be used.
 */
var mzOptionStr = [
    'A:(amqp-host)',
    'B:(amqp-password)',
    'C:(amqp-login)',
    'D:(amqp-port)',
    'E:(amqp-timeout)',

    'a(all-zones)',
    'c(concurrency)',
    'd:(dir)',
    'g:(get)',
    'G(global-zones)',
    'n(dry-run)',
    'p:(put)',
    's:(service)',
    'z:(zonename)',
    'I(immediate)',
    'J(jsonstream)',
    'N(oneline)',
    'S:(compute-node)',
    'T:(exectimeout)',
    'X(clobber)'
].join('');

/*
 * Default configuration values.
 */

var mzConcurrency = 10;			/* concurrency for Ur commands */
var mzExecTimeoutDefault = 60 * 1000;	/* milliseconds */
var mzAmqpConnectTimeoutDefault = 5000;	/* milliseconds */
var mzAmqpPortDefault = 5672;		/* standard amqp port */
var mzAmqpLoginDefault = 'guest';	/* suitable for sdc/manta */
var mzAmqpPasswordDefault = 'guest';	/* suitable for sdc/manta */

function main()
{
	var args, exec, next;

	cmdutil.exitOnEpipe();
	cmdutil.configure({
	    'synopses': mzSynopses,
	    'usageMessage': mzUsageMessage
	});

	args = mzParseCommandLine(process.argv.slice(2));
	if (args instanceof Error) {
		cmdutil.usage(args);
	}

	if (args === null) {
		/* error message emitted by getopt */
		cmdutil.usage();
	}

	/*
	 * By default, we hide virtually all bunyan log messages.  It would be
	 * better to log these to a local file, but we don't have a great
	 * solution for this.  ("/var/log" isn't necessarily writable, and
	 * "/var/tmp", isn't appropriate.  Plus, we want to append to the log
	 * rather than to replace whatever's there.  We also want to make sure
	 * it gets flushed on operational errors.)  We don't want to clutter the
	 * user's terminal, even when things go wrong, since we should be
	 * reporting actionable operational errors through the usual mechanisms.
	 * Users can enable logging by setting LOG_LEVEL.
	 */
	args.log = new bunyan({
	    'name': 'manta-oneach',
	    'level': process.env['LOG_LEVEL'] || 'fatal'
	});

	exec = new oneach.mzCommandExecutor(args);
	if (args.outputMode == 'text') {
		next = new oneach.mzResultToText({
		    'omitHeader': args.omitHeader,
		    'outputBatch': args.outputBatch,
		    'multilineMode': args.multilineMode
		});
	} else {
		assert.equal(args.outputMode, 'jsonstream');
		next = new oneach.mzResultToJson();
	}

	exec.pipe(next);
	next.pipe(process.stdout);

	exec.on('error', function (err) {
		cmdutil.fail(err);
	});

	process.stdout.on('finish', function () {
		if (exec.nexecerrors() > 0) {
			process.exit(1);
		}
	});
}

/*
 * Parse command-line arguments out of "argv".  This function is factored
 * separately for automated testing.  A non-Error return value represents part
 * of the argument to mzCommandExecutor().
 */
function mzParseCommandLine(argv)
{
	var parser, option, args, p, err;
	var multiline = null;

	args = {
	    'amqpHost': null,
	    'amqpPort': mzAmqpPortDefault,
	    'amqpTimeout': mzAmqpConnectTimeoutDefault,
	    'amqpLogin': mzAmqpLoginDefault,
	    'amqpPassword': mzAmqpPasswordDefault,
	    'sdcMantaConfigFile': sdc.sdcMantaConfigPathDefault,

	    'scopeAllZones': false,
	    'scopeComputeNodes': null,
	    'scopeZones': null,
	    'scopeServices': null,
	    'scopeGlobalZones': false,

	    'concurrency': mzConcurrency,
	    'dryRun': false,
	    'streamStatus': process.stderr,

	    'execMode': oneach.MZ_EM_COMMAND,
	    'execTimeout': mzExecTimeoutDefault,
	    'execCommand': null,
	    'execFile': null,
	    'execDirectory': null,
	    'execClobber': null,
	    'bindIp': null,

	    'omitHeader': false,
	    'outputMode': 'text',
	    'outputBatch': true,
	    'multilineMode': 'auto'
	};

	parser = new getopt.BasicParser(mzOptionStr, argv, 0);
	while ((option = parser.getopt()) !== undefined) {
		switch (option.option) {
		/*
		 * The AMQP options are given undocumented short options to
		 * satisfy getopt.
		 */
		case 'A':
			args.amqpHost = option.optarg;
			break;

		case 'B':
			args.amqpPassword = option.optarg;
			break;

		case 'C':
			args.amqpLogin = option.optarg;
			break;

		case 'D':
			p = parseInt(option.optarg, 10);
			if (isNaN(p) || p <= 0) {
				return (new VError(
				    'expected positive integer for ' +
				    '--amqp-port, but got: %s', option.optarg));
			}
			args.amqpPort = p;
			break;

		case 'E':
			p = parseInt(option.optarg, 10);
			if (isNaN(p) || p <= 0) {
				return (new VError(
				    'expected positive integer for ' +
				    '--amqp-timeout, but got: %s',
				    option.optarg));
			}
			args.amqpTimeout = p;
			break;


		/*
		 * Scoping options
		 */

		case 'a':
			args.scopeAllZones = true;
			break;

		case 'n':
			args.dryRun = true;
			break;

		case 's':
			if (args.scopeServices === null) {
				args.scopeServices = [];
			}

			args.scopeServices = appendCommaSeparatedList(
			    args.scopeServices, option.optarg);
			break;

		case 'z':
			if (args.scopeZones === null) {
				args.scopeZones = [];
			}
			args.scopeZones = appendCommaSeparatedList(
			    args.scopeZones, option.optarg);
			break;

		case 'G':
			args.scopeGlobalZones = true;
			break;

		case 'S':
			if (args.scopeComputeNodes === null) {
				args.scopeComputeNodes = [];
			}

			args.scopeComputeNodes = appendCommaSeparatedList(
			    args.scopeComputeNodes, option.optarg);
			break;

		/*
		 * Other options
		 */
		case 'c':
			p = parseInt(option.optarg, 10);
			if (isNaN(p) || p <= 0) {
				return (new VError(
				    'expected positive integer for ' +
				    '-c/--concurrency, but got: %s',
				    option.optarg));
			}
			args.concurrency = p;
			break;

		case 'd':
			args.execDirectory = option.optarg;
			break;

		case 'g':
			if (args.execMode != oneach.MZ_EM_COMMAND) {
				return (new VError('unexpected --get'));
			}
			args.execFile = option.optarg;
			args.execMode = oneach.MZ_EM_SENDTOREMOTE;
			if (args.execClobber === null) {
				args.execClobber = false;
			}
			break;

		case 'p':
			if (args.execMode != oneach.MZ_EM_COMMAND) {
				return (new VError('unexpected --put'));
			}
			args.execFile = option.optarg;
			args.execMode = oneach.MZ_EM_RECEIVEFROMREMOTE;
			break;

		case 'I':
			args.multilineMode = 'multi';
			args.outputBatch = false;
			break;

		case 'J':
			args.outputMode = 'jsonstream';
			break;

		case 'N':
			multiline = 'one';
			break;

		case 'T':
			p = parseInt(option.optarg, 10);
			if (isNaN(p) || p <= 0) {
				return (new VError(
				    'expected positive integer for ' +
				    '-T/--exectimeout, but got: %s',
				    option.optarg));
			}
			args.execTimeout = p * 1000;
			break;

		case 'X':
			args.execClobber = true;
			break;

		default:
			/* error message already emitted by getopt */
			assert.equal('?', option.option);
			return (null);
		}
	}


	/*
	 * The --oneline option overrides the implied semantics of --immediate,
	 * regardless of the order in which they were specified.
	 */
	if (multiline == 'one') {
		args.multilineMode = 'one';
	}

	if (args.execMode == oneach.MZ_EM_COMMAND) {
		if (parser.optind() >= argv.length) {
			return (new Error('expected command'));
		}

		if (parser.optind() < argv.length - 1) {
			return (new Error('unexpected arguments'));
		}

		args.execCommand = argv[parser.optind()];
	} else {
		if (parser.optind() < argv.length) {
			return (new Error('unexpected arguments'));
		}

		if (args.execDirectory === null) {
			return (new Error(
			    '--dir is required with --put and --get'));
		}
	}

	/*
	 * We've checked the syntax of the command-line by this point.  Now
	 * check the semantics: many combinations of options are not valid.
	 */
	err = oneach.mzValidateScopeParameters(args);
	if (err instanceof Error) {
		return (err);
	}

	return (args);
}

/*
 * Given an array "list" and a string value "strval" that may contain several
 * comma-separated values, split "strval" by commas and append each of the
 * resulting substrings to "list".  Empty substrings are ignored.  This is used
 * to allow users to specify options like:
 *
 *     -z ZONENAME1,ZONENAME2,ZONENAME3
 *
 * as equivalent to:
 *
 *     -z ZONENAME1 -z ZONENAME2 -z ZONENAME3
 */
function appendCommaSeparatedList(list, strval)
{
	return (list.concat(strval.split(',').filter(
	    function (s) { return (s.length > 0); })));
}

main();
