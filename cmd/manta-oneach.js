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
 * Examples:
 *
 *     # execute COMMAND in all non-local zones (NOT global zones)
 *     manta-oneach -a | --all-zones COMMAND
 *
 *     # execute COMMAND in specified zones
 *     manta-oneach -z | --zonename ZONENAME ... COMMAND
 *
 *     # execute COMMAND in all zones of service SERVICE (e.g., "webapi")
 *     manta-oneach -s | --service SERVICE ... COMMAND
 *
 *     # execute COMMAND in all GZs for all nodes used for Manta
 *     manta-oneach -g | --global-zones COMMAND
 *
 * In all cases, COMMAND is interpreted as an arbitrary bash script, just like
 * sdc-oneachnode.  The following options have the same semantics as with
 * sdc-oneachnode:
 *
 *     -T | --exectimeout SECONDS
 */

var assert = require('assert');
var bunyan = require('bunyan');
var cmdln = require('cmdln');
var cmdutil = require('cmdutil');
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
    '-a | --all-zones COMMAND',
    '-g | --global-zones COMMAND',
    '-S | --compute-node HOSTNAME|SERVER_UUID... COMMAND',
    '-s | --service SERVICE... COMMAND',
    '-z | --zonename ZONENAME... COMMAND'
];

var mzUsageMessage = [
    '',
    'Execute a shell command on all Manta zones or a subset of zones using ',
    'filters based on zonename, service name, or compute node.'
].join('\n');

var mzOptionStr = [
    'A:(amqp-host)',
    'B:(amqp-password)',
    'C:(amqp-login)',
    'D:(amqp-port)',
    'E:(amqp-timeout)',

    'a(all-zones)',
    'c(concurrency)',
    'g(global-zones)',
    'n(dry-run)',
    's:(service)',
    'z:(zonename)',
    'S:(compute-node)',
    'T:(exectimeout)'
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
	var args, exec;

	/*
	 * XXX This should move into node-cmdutil.
	 */
	process.stdout.on('error', function (err) {
		if (err.code == 'EPIPE')
			process.exit(0);
		throw (err);
	});

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
	exec.execute(function (err) {
		if (err) {
			args.log.error(err, 'fatal error');
			cmdutil.fail(err);
		}

		args.log.info('done');
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

	args = {
	    'amqpHost': null,
	    'amqpPort': mzAmqpPortDefault,
	    'amqpTimeout': mzAmqpConnectTimeoutDefault,
	    'amqpLogin': mzAmqpLoginDefault,
	    'amqpPassword': mzAmqpPasswordDefault,
	    'sdcConfigFile': sdc.sdcConfigPathDefault,

	    'scopeAllZones': false,
	    'scopeComputeNodes': null,
	    'scopeZones': null,
	    'scopeServices': null,
	    'scopeGlobalZones': false,

	    'concurrency': mzConcurrency,
	    'dryRun': false,
	    'streamStatus': process.stderr,

	    'execTimeout': mzExecTimeoutDefault,
	    'execCommand': null
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

		case 'g':
			args.scopeGlobalZones = true;
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

		default:
			/* error message already emitted by getopt */
			assert.equal('?', option.option);
			return (null);
		}
	}

	if (parser.optind() >= argv.length) {
		return (new Error('expected command'));
	}

	if (parser.optind() < argv.length - 1) {
		return (new Error('unexpected arguments'));
	}

	args.execCommand = argv[parser.optind()];

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
