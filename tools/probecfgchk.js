#!/usr/bin/env node

/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * probecfgchk: validates a given probe configuration file
 */

var cmdutil = require('cmdutil');
var vasync = require('vasync');
var VError = require('verror');

var priv_probe_template = require('../lib/alarms/probe_template');
var nerrors = 0;

function main()
{
	cmdutil.configure({
	    'synopses': [ 'FILENAME...' ],
	    'usageMessage': 'validates one or more probe template files'
	});

	if (process.argv.length < 3) {
		cmdutil.usage();
	}

	vasync.forEachPipeline({
	    'func': validateOneFile,
	    'inputs': process.argv.slice(2)
	}, function () {
		process.exit(nerrors === 0 ? 0 : 1);
	});
}

function validateOneFile(filename, callback)
{
	var pts;

	pts = new priv_probe_template.ProbeTemplates();
	pts.loadFromFile(filename, function onLoaded() {
		var errors;

		errors = pts.errors();
		nerrors += errors.length;

		if (errors.length == 1) {
			cmdutil.warn(errors[0]);
		} else if (errors.length > 1) {
			cmdutil.warn(new VError.MultiError(errors));
		} else {
			console.error('%s okay', filename);
		}

		callback();
	});
}

main();