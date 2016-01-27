/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * tst.oneach_exec.js: unit test for mzCommandExecutor.  We mock out the Ur
 * client and load a fake deployment into the MantaAdm client and make sure that
 * the command executor does the right things.  This test is not as exhaustive
 * as it could be.
 */

var assertplus = require('assert-plus');
var bunyan = require('bunyan');
var cmdutil = require('cmdutil');
var forkexec = require('forkexec');
var jsprim = require('jsprim');
var path = require('path');
var vasync = require('vasync');
var VError = require('verror').VError;

var madm = require('../lib/adm');
var oneach = require('../lib/oneach/oneach');
var testcommon = require('./common');

var test_cases = [ {
    'name': 'complex command on all zones',
    'args': {
	'scopeAllZones': true,
	'execMode': oneach.MZ_EM_COMMAND,
	'execCommand': 'ls | foo > bar && echo bob'
    },
    'expected_results': {
	'count': 16,
	'zone': true,
	'output': 'in zone'
    }
}, {
    'name': 'basic command in all global zones',
    'args': {
	'scopeAllZones': true,
	'scopeGlobalZones': true,
	'execMode': oneach.MZ_EM_COMMAND,
	'execCommand': 'junk'
    },
    'expected_results': {
	'count': 2,
	'zone': false,
	'output': 'global zone'
    }
}, {
    'name': 'basic command in specific zones and services',
    'args': {
	'scopeZones': [ 'zone1', 'zone3', 'zone5' ],
	'scopeServices': [ 'webapi' ],
	'execMode': oneach.MZ_EM_COMMAND,
	'execCommand': 'junk'
    },
    'expected_results': {
	'count': 2,
	'zone': true,
	'output': 'in zone'
    }
}, {
    'name': 'basic command on specific CNs',
    'args': {
	'scopeZones': [ 'zone1', 'zone3', 'zone5', 'zone7' ],
	'scopeComputeNodes': [ 'cn0' ],
	'execMode': oneach.MZ_EM_COMMAND,
	'execCommand': 'junk'
    },
    'expected_results': {
	'count': 3,
	'zone': true,
	'output': 'in zone'
    }
}, {
    'name': 'basic command in GZ for specific services',
    'args': {
	'scopeZones': [ 'zone1', 'zone3', 'zone5' ],
	'scopeServices': [ 'webapi' ],
	'scopeGlobalZones': true,
	'execMode': oneach.MZ_EM_COMMAND,
	'execCommand': 'junk'
    },
    'expected_results': {
	'count': 1,
	'zone': false,
	'output': 'global zone'
    }
}, {
    'name': 'attempted execution of unsupported command',
    'error': /unsupported command/,
    'args': {
	'scopeZones': [ 'zone1' ],
	'execMode': oneach.MZ_EM_COMMAND,
	'execCommand': 'echo 288dd530'
    }
}, {
    'name': 'no zones matches',
    'error': /no matching zones found/,
    'args': {
	'scopeServices': [ 'postgres' ],
	'execMode': oneach.MZ_EM_COMMAND,
	'execCommand': 'date'
    }
}, {
    'name': 'bad zonename',
    'error': /unknown zonename: zone123456789/,
    'args': {
	'scopeZones': [ 'zone123456789' ],
	'execMode': oneach.MZ_EM_COMMAND,
	'execCommand': 'date'
    }
}, {
    'name': 'PUT: global zone',
    'args': {
	'scopeGlobalZones': true,
	'scopeZones': [ 'zone1' ],
	'bindIp': '127.0.0.1',
	'execMode': oneach.MZ_EM_RECEIVEFROMREMOTE,
	'execDirectory': '/local/dir1',
	'execFile': '/remote/file/1'
    },
    'expected_results': {
	'count': 1,
	'zone': false,
	'src_file': '/remote/file/1',
	'dst_dir': '/local/dir1'
    }
}, {
    'name': 'GET: global zone',
    'args': {
	'scopeGlobalZones': true,
	'scopeZones': [ 'zone1' ],
	'bindIp': '127.0.0.1',
	'execMode': oneach.MZ_EM_SENDTOREMOTE,
	'execDirectory': '/remote/dir1',
	'execFile': '/local/file/1'
    },
    'expected_results': {
	'count': 1,
	'zone': false,
	'src_file': '/remote/file/1',
	'dst_dir': '/local/dir1'
    }
}, {
    'name': 'PUT: non-global zone',
    'args': {
	'scopeZones': [ 'zone1' ],
	'bindIp': '127.0.0.1',
	'execMode': oneach.MZ_EM_RECEIVEFROMREMOTE,
	'execDirectory': '/local/dir1',
	'execFile': '/zones/zone1/root/remote/file/1'
    },
    'expected_results': {
	'count': 1,
	'zone': true,
	'src_file': '/remote/file/1',
	'dst_dir': '/local/dir1'
    }
}, {
    'name': 'GET: global zone',
    'args': {
	'scopeZones': [ 'zone1' ],
	'bindIp': '127.0.0.1',
	'execMode': oneach.MZ_EM_SENDTOREMOTE,
	'execDirectory': '/remote/dir1',
	'execFile': '/local/file/1'
    },
    'expected_results': {
	'count': 1,
	'zone': true,
	'src_file': '/zones/zone1/root/remote/file/1',
	'dst_dir': '/local/dir1'
    }
} ];

var nexecuted = 0;

function main()
{
	var done = false;

	vasync.forEachPipeline({
	    'inputs': test_cases,
	    'func': runTestCase
	}, function (err) {
		if (err) {
			cmdutil.fail(err);
		}

		assertplus.equal(nexecuted, test_cases.length);
		console.error('done (%d executed)', nexecuted);
		done = true;
	});

	process.on('exit', function (code) {
		if (code === 0) {
			assertplus.ok(done, 'premature exit');
		}
	});
}

function runTestCase(testcase, callback)
{
	var exec, args, results;

	console.error('test case: %s', testcase['name']);

	/*
	 * Set up the command executor.
	 */
	args = testcommon.defaultCommandExecutorArgs();
	jsprim.forEachKey(testcase['args'], function (k, v) { args[k] = v; });
	args.streamStatus = process.stderr;
	args.log = new bunyan({
	    'name': 'tst.oneach_exec.js',
	    'level': process.env['LOG_LEVEL'] || 'fatal'
	});

	results = [];
	exec = new oneach.mzCommandExecutor(args);

	/*
	 * Monkey-patch the command executor to use our mocks.
	 */
	assertplus.func(exec.stageSetupUr);
	exec.stageSetupUr = setupMockUr;
	assertplus.func(exec.stageSetupManta);
	exec.stageSetupManta = setupMockManta;

	/*
	 * Record all the results as it executes.
	 */
	exec.on('data', function (c) { results.push(c); });
	exec.on('error', function (err) {
		finishTest(testcase, exec, err, results, callback);
	});
	exec.on('end', function () {
		finishTest(testcase, exec, null, results, callback);
	});
}

function finishTest(testcase, exec, error, results, callback)
{
	var mock = exec.ce_urclient;
	assertplus.ok((error !== null && mock === null) ||
	    mock instanceof MockUrClient);

	if (testcase['error']) {
		nexecuted++;

		if (error === null) {
			console.error('expected error: ', testcase['error']);
			console.error('found no error');
			callback(new VError('missing expected error'));
		} else if (!testcase['error'].test(error.message)) {
			console.error('expected error: ', testcase['error']);
			console.error('found error: ', error.message);
			callback(new VError('wrong error'));
		} else {
			callback();
		}

		return;
	}

	if (error !== null) {
		nexecuted++;
		console.error('expected no error, but found one');
		console.error('found error: ', error);
		callback(new VError('unexpected error'));
		return;
	}

	/* XXX implement the most common cases */
	nexecuted++;
	callback();
}


/*
 * Our mock Ur client records the methods that were called and responds with an
 * appropriate success response.
 */
function setupMockUr(_, callback)
{
	assertplus.ok(this.ce_urclient === null);
	this.ce_urclient = new MockUrClient();
	setImmediate(callback);
}

function MockUrClient()
{
	this.muc_calls = [];
}

MockUrClient.prototype.send_file = function (args, callback)
{
	this.muc_calls.push({
	    'method': 'send_file',
	    'args': args
	});

	setImmediate(callback, {
	    'exit_status': 0,
	    'stdout': 'ok',
	    'stderr': ''
	});
};

MockUrClient.prototype.recv_file = function (args, callback)
{
	this.muc_calls.push({
	    'method': 'recv_file',
	    'args': args
	});

	setImmediate(callback, {
	    'exit_status': 0,
	    'stdout': 'ok',
	    'stderr': ''
	});
};

MockUrClient.prototype.exec = function (args, callback)
{
	var iszone;

	this.muc_calls.push({
	    'method': 'exec',
	    'args': args
	});

	iszone = args['script'].indexOf('zlogin') != -1;
	setImmediate(callback, {
	    'exit_status': 0,
	    'stdout': iszone ? 'in zone' : 'global zone',
	    'stderr': ''
	});
};

MockUrClient.prototype.close = function ()
{
};


/*
 * Our "mock" MantaAdm client is just a normal client with a fake topology
 * loaded.
 */
function setupMockManta(_, callback)
{
	var fakeDeployedTopology;
	var i, zoneid, cnid;

	fakeDeployedTopology = {};
	fakeDeployedTopology.app = {};
	fakeDeployedTopology.app.name = 'manta';
	fakeDeployedTopology.services = {
	    'svc001': { 'name': 'webapi' }
	};
	fakeDeployedTopology.instances = { 'svc001': [] };
	fakeDeployedTopology.vms = {};

	for (i = 0; i < 8; i++) {
		zoneid = 'zone' + (i + 1);
		cnid = 'cn' + (i % 2);
		fakeDeployedTopology.instances['svc001'].push({
		    'uuid': zoneid,
		    'params': { 'server_uuid': cnid },
		    'metadata': { 'SHARD': '1', 'DATACENTER': 'test' }
		});
		fakeDeployedTopology.vms[zoneid] = {
		    'nics': [ {
			'primary': true,
			'ip': '10.0.0.' + (i + 1)
		    } ]
		};
	}

	fakeDeployedTopology.cns = {};
	fakeDeployedTopology.cns['cn0'] = {
	    'datacenter': 'test',
	    'hostname': 'CN0',
	    'server_uuid': 'CN0',
	    'sysinfo': { 'Network Interfaces': {} }
	};

	assertplus.ok(this.ce_manta === null);
	this.ce_manta = new madm.MantaAdm(
	    this.ce_log.child({ 'component': 'MantaAdm' }));
	this.ce_manta.loadFakeDeployed(fakeDeployedTopology);
	setImmediate(callback);
}

main();
