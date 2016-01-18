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
 *     # XXX should this be combinable with -s STORAGE to grab GZs hosting those
 *     # services?
 *     manta-oneach -g | --global-zones COMMAND
 *
 * In all cases, COMMAND is interpreted as an arbitrary bash script, just like
 * sdc-oneachnode.  The following options have the same semantics as with
 * sdc-oneachnode:
 *
 *     -T | --exectimeout SECONDS
 */

var bunyan = require('bunyan');
var cmdln = require('cmdln');
var jsprim = require('jsprim');
var path = require('path');
var util = require('util');
var vasync = require('vasync');
var VError = require('verror').VError;
var common = require('../lib/common');
var madm = require('../lib/adm');

var mzArg0 = path.basename(process.argv[1]);

var mzSynopses = [
    '-a | --all-zones COMMAND',
    '-g | --global-zones COMMAND',
    '-n | --compute-node HOSTNAME|SERVER_UUID... COMMAND',
    '-s | --service SERVICE... COMMAND',
    '-z | --zonename ZONENAME... COMMAND'
] ;

var mzUsageMessage = [
    '',
    'Execute a shell command on all Manta zones or a subset of zones using ',
    'filters based on zonename, service name, or compute node.'
].join('\n');

var mzOptionStr = [
    'a(all-zones)',
    'g(global-zones)',
    'n:(compute-node)',
    's:(service)',
    'z:(zonename)',
    'T:(exectimeout)'
].join('');

/*
 * Default configuration values.
 */

var mzExecTimeoutDefault = 60 * 1000;	/* milliseconds */

function main()
{
	var parser, option, args, p;

	/*
	 * XXX This should move into node-cmdutil.
	 */
	process.stdout.on('error', function (err) {
		if (err.code == 'EPIPE')
			process.exit(0);
		throw (err);
	});

	mod_cmdutil.configure({
	    'synopses': mzSynopses,
	    'usageMessage': mzUsageMessage
	});

	args = mzParseCommandLine(process.argv.slice(2))
	if (args instanceof Error) {
		mod_cmdutil.usage(args);
	}

	if (args === null) {
		/* error message emitted by getopt */
		mod_cmdutil.usage();
	}

	/* XXX do something here */
	console.error(args);
}

/*
 * Parse command-line arguments out of "argv".  This function is factored
 * separately for automated testing.
 */
function mzParseCommandLine(argv)
{
	var parser, option, args, p, count;

	args = {
	    'filterAllZones': false,
	    'filterComputeNodes': null,
	    'filterZones': null,
	    'filterServices': null,
	    'filterGlobalZones': false,
	    'execTimeout': mzExecTimeoutDefault,
	    'execCommand': null
	};

	parser = new mod_getopt.BasicParser(mzOptionStr, argv, 0);
	while ((option = parser.getopt()) !== undefined) {
		switch (option.option) {
		case 'a':
			args.filterAllZones = true;
			break;

		case 'g':
			args.filterGlobalZones = true;
			break;

		case 'n':
			if (args.filterComputeNodes === null) {
				args.filterComputeNodes = [];
			}

			args.filterComputeNodes = appendCommaSeparatedList(
			    args.filterComputeNodes, option.optarg);
			break;

		case 's':
			if (args.filterServices === null) {
				args.filterServices = [];
			}

			args.filterServices = appendCommaSeparatedList(
			    args.filterServices, option.optarg);
			break;

		case 'z':
			if (args.filterZones === null) {
				args.filterZones = [];
			}
			args.filterZones = appendCommaSeparatedList(
			    args.filterZones, option.optarg);
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
			mod_assert.equal('?', option.option);
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
	count = 0;
	if (args.filterAllZones) {
		count++;
	}

	if (args.filterComputeNodes !== null) {
		count++;
	}

	if (args.filterZones !== null) {
		count++;
	}

	if (args.filterServices !== null) {
		count++;
	}

	if (args.filterGlobalZones) {
		count++;
	}

	if (count > 1) {
		return (new VError('only one of the filtering arguments ' +
		    'may be specified'));
	}

	if (count === 0) {
		return (new VError('one of the filtering arguments ' +
		    'must be specified'));
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
