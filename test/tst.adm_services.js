/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * tst.adm_services.js: tests "manta-adm services"
 */

var assert = require('assert');
var bunyan = require('bunyan');
var jsprim = require('jsprim');
var vasync = require('vasync');
var CollectorStream = require('./CollectorStream');
var VError = require('verror').VError;

var madm = require('../lib/adm');

var testCases = [ {
    'name': 'basic output',
    'options': {},
    'desiredOutput': [
	'SERVICE          CONFIGURED IMAGE                    ',
	'authcache        imgid_5                             ',
	'electric-moray   imgid_3                             ',
	'jobpuller        imgid_9                             ',
	'jobsupervisor    imgid_8                             ',
	'loadbalancer     imgid_7                             ',
	'madtom           imgid_12                            ',
	'marlin           imgid_14                            ',
	'marlin-dashboard imgid_13                            ',
	'medusa           imgid_10                            ',
	'moray            imgid_2                             ',
	'nameservice      imgid_0                             ',
	'ops              imgid_11                            ',
	'postgres         imgid_1                             ',
	'storage          imgid_4                             ',
	'webapi           imgid_6                             '
    ]
}, {
    'name': 'omit header',
    'options': {
	'omitHeader': true
    },
    'desiredOutput': [
	'authcache        imgid_5                             ',
	'electric-moray   imgid_3                             ',
	'jobpuller        imgid_9                             ',
	'jobsupervisor    imgid_8                             ',
	'loadbalancer     imgid_7                             ',
	'madtom           imgid_12                            ',
	'marlin           imgid_14                            ',
	'marlin-dashboard imgid_13                            ',
	'medusa           imgid_10                            ',
	'moray            imgid_2                             ',
	'nameservice      imgid_0                             ',
	'ops              imgid_11                            ',
	'postgres         imgid_1                             ',
	'storage          imgid_4                             ',
	'webapi           imgid_6                             '
    ]
}, {
    'name': 'omit header and specify column',
    'options': {
	'omitHeader': true,
	'columns': [ 'service' ]
    },
    'desiredOutput': [
	'authcache       ',
	'electric-moray  ',
	'jobpuller       ',
	'jobsupervisor   ',
	'loadbalancer    ',
	'madtom          ',
	'marlin          ',
	'marlin-dashboard',
	'medusa          ',
	'moray           ',
	'nameservice     ',
	'ops             ',
	'postgres        ',
	'storage         ',
	'webapi          '
    ]
}, {
    'name': 'filter by service',
    'options': {
	'filter': 'jobpuller'
    },
    'desiredOutput': [
	'SERVICE          CONFIGURED IMAGE                    ',
	'jobpuller        imgid_9                             '
    ]
}, {
    'name': 'filter by service, omit headers, select image',
    'options': {
	'omitHeader': true,
	'columns': [ 'image' ],
	'filter': 'moray'
    },
    'desiredOutput': [
	'imgid_2                             '
    ]
} ];

function main()
{
	var verbose, log, fakeBase;

	verbose = process.argv.length > 2 && process.argv[2] == '-v';

	log = new bunyan({
	    'name': 'tst.adm_services.js',
	    'level': process.env['LOG_LEVEL'] || 'warn',
	    'serializers': bunyan.stdSerializers
	});

	fakeBase = {
	    'app': { 'name': 'manta' },
	    'services': { /* filled in below */ },
	    'instances': {},
	    'vms': {},
	    'cns': {}
	};

	[
	    'nameservice',
	    'postgres',
	    'moray',
	    'electric-moray',
	    'storage',
	    'authcache',
	    'webapi',
	    'loadbalancer',
	    'jobsupervisor',
	    'jobpuller',
	    'medusa',
	    'ops',
	    'madtom',
	    'marlin-dashboard',
	    'marlin'
	].forEach(function (svcname, i) {
		var svcwhich = i++;
		var svcid = 'svcid_' + svcwhich;

		fakeBase['services'][svcid] = {
		    'name': svcname,
		    'params': {
			'image_uuid': 'imgid_' + svcwhich
		    }
		};
	});

	vasync.forEachPipeline({
	    'inputs': testCases,
	    'func': function runTestCaseInPipeline(testcase, callback) {
		runTestCase({
		    'log': log,
		    'fakeBase': fakeBase,
		    'testCase': testcase,
		    'verbose': verbose
		}, callback);
	    }
	}, function (err) {
		if (err)
			throw (err);
		console.log('TEST PASSED');
	});
}

function runTestCase(args, callback)
{
	var deployedConfig = args['fakeBase'];
	var log = args['log'];
	var t = args['testCase'];
	var verbose = args['verbose'];
	var adm, collector;
	var i, linestocheck;
	var gotlines, wantlines, bad;

	console.log('test case "%s"', t['name']);
	adm = new madm.MantaAdm(log);
	adm.loadFakeDeployed(deployedConfig);

	collector = new CollectorStream({});
	adm.dumpServices(collector, t['options']);

	gotlines = collector.data.split(/\n/);
	wantlines = t['desiredOutput'].concat('');
	linestocheck = Math.min(gotlines.length, wantlines.length);

	bad = gotlines.length != wantlines.length;
	for (i = 0; !bad && i < linestocheck; i++) {
		bad = bad || (gotlines[i] != wantlines[i]);
	}

	if (bad || verbose) {
		console.error('expected:');
		wantlines.forEach(function (w) {
			console.error('    >%s<', w);
		});

		console.error('found:');
		gotlines.forEach(function (g) {
			console.error('    >%s<', g);
		});
	}

	if (bad) {
		throw (new VError('mismatch on test case "%s"', t['name']));
	}

	setImmediate(callback);
}

main();
