/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * tst.update.js: tests facilities used to update a the deployed probes and
 * probe groups.
 */

var assertplus = require('assert-plus');
var bunyan = require('bunyan');
var jsprim = require('jsprim');
var sprintf = require('extsprintf').sprintf;
var vasync = require('vasync');

var alarms = require('../../lib/alarms');
var alarm_metadata = require('../../lib/alarms/metadata');
var instance_info = require('../../lib/instance_info');
var mock_amon = require('./mock_amon');
var services = require('../../lib/services');

/*
 * Parameters used for all of the tests.
 */
var account = mock_amon.account;
var contactsBySeverity = {
    'minor': [ 'minor_contact1', 'minor_contact2', 'minor_contact3' ],
    'major': [ 'major_contact' ],
    'critical': [ 'critical_contact1', 'critical_contact2' ]
};

/*
 * nInstancesBySvc is used to generate a list of fake VMs and CNs for a
 * datacenter.  The only reason that the code we're testing isn't completely
 * agnostic to service names is because the implementation of the "all" scope
 * requires knowing all of the service names.  We don't actually need to
 * exercise every service differently, and doing so would be pretty tedious
 * because we'll need to manually list out all of the expected probes for every
 * instance.  So we only define a few instances and test out those.
 */
var nInstancesBySvc = {
    'nameservice': 3,
    'jobsupervisor': 2
};

/*
 * We will generate a few different groups of datacenter-related parameters:
 *
 * - configuration representing an empty datacenter
 * - configuration representing a complete single-DC deployment
 * - configuration representing one DC in a multi-DC deployment, where some
 *   normally-necessary services may not be in this DC (e.g., "ops")
 *
 * These are filled in by generateTestData().
 */
var testParamsByDcConfig = {
    'cfg_empty': {
	'ctp_servers': [],		/* local server uuids */
	'ctp_instances': {},		/* all instances (all DCs) */
	'ctp_instances_by_svcname': {},	/* local instances, by svcname */
	'ctp_deployed_full': null,	/* deployed probes when full */
	'ctp_deployed_none': null,	/* deployed probes when empty */
	'ctp_deployed_extra': null	/* deployed probes when full, plus */
    },

    'cfg_basic': {
	'ctp_servers': [],
	'ctp_instances': {},
	'ctp_instances_by_svcname': {},
	'ctp_deployed_full': null,
	'ctp_deployed_none': null,
	'ctp_deployed_extra': null,
	'dtp_deployed_partial': null
    },

    'cfg_multi': {
	'ctp_servers': [],
	'ctp_instances': {},
	'ctp_instances_by_svcname': {},
	'ctp_deployed_full': null,
	'ctp_deployed_none': null,
	'ctp_deployed_extra': null,
	'dtp_deployed_partial': null
    }
};

/*
 * We'll test a couple of different metadata configurations: one with no
 * metadata (as a degenerate case), and a set of basic metadata that covers a
 * bunch of different cases:
 *
 *    - scopes: a specific service, "all", and "each"; normally, with "global",
 *      and with "checkFrom"
 *    - probes: a basic command, and one using "autoEnv"
 */
var emptyMetadata, basicMetadata;
var testCases;

function main()
{
	generateTestData(function () {
		generateTestCases();
		testCases.forEach(runTestCase);

	/*
	 * XXX
	 * Test cases that we want to exercise:
	 * - given an incomplete DC within multi-DC, no probes, generate update
	 *   plan
	 *
	 * - Clean up and document this test file.
	 */
		console.log('%s okay', __filename);
	});
}

function generateTestData(callback)
{
	var instances, instancesBySvc, servernames;
	var mdl, errors, log;

	/*
	 * The empty DC is easy: just set up the data structure.
	 */
	jsprim.forEachKey(nInstancesBySvc, function (svcname, n) {
		testParamsByDcConfig.cfg_empty.ctp_instances_by_svcname[
		    svcname] = [];
	});

	/*
	 * For the basic single datacenter case, fake up instances in numbers
	 * described by nInstancesBySvc.
	 */
	instances = testParamsByDcConfig.cfg_basic.ctp_instances;
	instancesBySvc = testParamsByDcConfig.cfg_basic.
	    ctp_instances_by_svcname;
	servernames = {};
	jsprim.forEachKey(nInstancesBySvc, function (svcname, n) {
		var i, instid, cnname;
		instancesBySvc[svcname] = [];
		for (i = 0; i < n; i++) {
			instid = sprintf('svc-%s-%d', svcname, i);
			/*
			 * We use only two different CN uuids to make sure that
			 * we re-use CNs for a given service.  That's in order
			 * to make sure that "global" scoped templates do not
			 * generate multiple probes for the same CN just because
			 * there are two instances of a service on that CN.
			 */
			cnname = sprintf('server-uuid-%d', i % 2);
			instancesBySvc[svcname].push(instid);
			instances[instid] = new instance_info.InstanceInfo({
			    'uuid': instid,
			    'svcname': svcname,
			    'server_uuid': cnname,
			    'local': true,
			    'metadata': {
				'sector': '7G'
			    }
			});

			servernames[cnname] = true;
		}
	});
	testParamsByDcConfig.cfg_basic.ctp_servers = Object.keys(servernames);

	/*
	 * For the multi-datacenter case, we need to fake up information about
	 * instances in all three DCs.
	 */
	instances = testParamsByDcConfig.cfg_multi.ctp_instances;
	instancesBySvc = testParamsByDcConfig.cfg_multi.
	    ctp_instances_by_svcname;
	servernames = {};
	jsprim.forEachKey(nInstancesBySvc, function (svcname, n) {
		var i, instid, cnname, iiargs;

		instancesBySvc[svcname] = [];

		/*
		 * This is a quick way of spreading instances across the
		 * datacenter.  It's not exactly how we'd really do it, but it
		 * should be close enough for our purposes.
		 */
		for (i = 0; i < n; i++) {
			instid = sprintf('dc%d-%s-inst%d',
			    i % 3, svcname, i);
			iiargs = {
			    'uuid': instid,
			    'svcname': svcname,
			    'metadata': {
				'sector': '7G'
			    }
			};

			/*
			 * Since we're already ignoring most services for the
			 * purpose of this test case, we know that there will be
			 * many services with no instances in the local
			 * datacenter.
			 */
			if (i % 3 === 0) {
				cnname = sprintf('server-uuid-%d', i);
				instancesBySvc[svcname].push(instid);
				iiargs['local'] = true;
				iiargs['server_uuid'] = cnname;
				servernames[cnname] = true;
			} else {
				iiargs['local'] = false;
				iiargs['server_uuid'] = null;
			}

			instances[instid] = new instance_info.InstanceInfo(
			    iiargs);
		}
	});
	testParamsByDcConfig.cfg_multi.ctp_servers = Object.keys(servernames);

	/*
	 * Now generate metadata.
	 */
	mdl = new alarm_metadata.MetadataLoader();
	mdl.loadFromString('[]', 'input');
	errors = mdl.errors();
	assertplus.strictEqual(errors.length, 0);
	emptyMetadata = mdl.mdl_amoncfg;

	mdl = new alarm_metadata.MetadataLoader();
	mdl.loadFromString(JSON.stringify([ {
	    /* scope: basic service scope */
	    'event': 'upset.manta.test.nameservice_broken',
	    'scope': { 'service': 'nameservice' },
	    'checks': [ {
		'type': 'cmd',
		'config': {
		    'env': { 'complex': 'snpp' },
		    'autoEnv': [ 'sector' ]
		}
	    } ],
	    'ka': {
		'title': 'test ka: basic "service" scope',
		'description': 'exercises a basic "service" scope template',
		'severity': 'minor',
		'response': 'none',
		'impact': 'none',
		'action': 'none'
	    }
	}, {
	    /* scope: "global" */
	    'event': 'upset.manta.test.global',
	    'scope': { 'service': 'nameservice', 'global': true },
	    'checks': [ { 'type': 'cmd', 'config': {} } ],
	    'ka': {
		'title': 'test ka: global "service" scope',
		'description': 'exercises a global "service" scope template',
		'severity': 'major',
		'response': 'none',
		'impact': 'none',
		'action': 'none'
	    }
	}, {
	    /* scope: "each" */
	    'event': 'upset.manta.test.$service',
	    'scope': { 'service': 'each' },
	    'checks': [ { 'type': 'cmd', 'config': {} } ],
	    'ka': {
		'title': 'test ka: each "service" scope',
		'description': 'exercises an "each" "service" scope template',
		'severity': 'critical',
		'response': 'none',
		'impact': 'none',
		'action': 'none'
	    }
	}, {
	    /* scope: "all" */
	    'event': 'upset.manta.test.all',
	    'scope': { 'service': 'all' },
	    'checks': [ { 'type': 'cmd', 'config': {} } ],
	    'ka': {
		'title': 'test ka: all "service" scope',
		'description': 'exercises an "all" "service" scope template',
		'severity': 'minor',
		'response': 'none',
		'impact': 'none',
		'action': 'none'
	    }
	} ]), 'input');
	errors = mdl.errors();
	assertplus.strictEqual(errors.length, 0);
	basicMetadata = mdl.mdl_amoncfg;

	/*
	 * Now, load Amon configurations.  We could provide a side door way to
	 * do this for testing, but it's nearly as easy to use our mock Amon
	 * anyway.
	 */
	log = new bunyan({
	    'name': 'tst.update.js',
	    'level': process.env['LOG_LEVEL'] || 'fatal',
	    'stream': process.stderr
	});

	mock_amon.createMockAmon(log, function (mock) {
		loadDeployedProbes(mock, function () {
			mock.server.close();
			callback();
		});
	});
}

/*
 * Generate MantaAmonConfig objects corresponding to the sets of deployed probes
 * that we're going to check against later.  We'll generate configs representing
 * no probes deployed, all probes deployed, and some probes deployed.
 */
function loadDeployedProbes(mock, callback)
{
	mock.config = {};
	mock.config.groups = [];
	mock.config.agentprobes = {};

	vasync.waterfall([
		/*
		 * Generate a config representing no probes deployed to the
		 * empty DC configuration.
		 */
		function emptyDcNoProbes(subcallback) {
			var dc = testParamsByDcConfig.cfg_empty;
			loadDeployedForConfig(mock, dc, function (cfg) {
				dc.ctp_deployed_none = cfg;
				subcallback();
			});
		},

		/*
		 * Generate a config representing no probes deployed to the
		 * basic single-DC configuration.
		 */
		function basicDcNoProbes(subcallback) {
			var dc = testParamsByDcConfig.cfg_basic;
			loadDeployedForConfig(mock, dc, function (cfg) {
				dc.ctp_deployed_none = cfg;
				subcallback();
			});
		},

		/*
		 * Generate a config representing no probes deployed to the
		 * multi-DC configuration.
		 */
		function multiDcNoProbes(subcallback) {
			var dc = testParamsByDcConfig.cfg_multi;
			loadDeployedForConfig(mock, dc, function (cfg) {
				dc.ctp_deployed_none = cfg;
				subcallback();
			});
		},

		/*
		 * Generate a config representing all of the expected probes
		 * deployed to the basic single-DC configuration.
		 */
		function basicDcFullProbes(subcallback) {
			var dc = testParamsByDcConfig.cfg_basic;
			mock.config.groups = [ {
			    'uuid': 'deployed-group-uuid-1',
			    'name': 'upset.manta.test.nameservice_broken;v=1',
			    'user': account,
			    'disabled': false,
			    'contacts': contactsBySeverity.minor
			}, {
			    'uuid': 'deployed-group-uuid-2',
			    'name': 'upset.manta.test.global;v=1',
			    'user': account,
			    'disabled': false,
			    'contacts': contactsBySeverity.major
			}, {
			    'uuid': 'deployed-group-uuid-3',
			    'name': 'upset.manta.test.all;v=1',
			    'user': account,
			    'disabled': false,
			    'contacts': contactsBySeverity.minor
			} ];

			services.mSvcNamesProbes.forEach(function (svcname, i) {
				svcname = svcname.replace(/-/g, '_');
				mock.config.groups.push({
				    'uuid': 'deployed-group-uuid-svc-' +
				        svcname,
				    'name': 'upset.manta.test.' + svcname +
				        ';v=1',
				    'user': account,
				    'disabled': false,
				    'contacts': contactsBySeverity.critical
				});
			});

			mock.config.agentprobes = {};
			mock.config.agentprobes['svc-nameservice-0'] = [
			    makeProbe({
			        'group': 'deployed-group-uuid-1',
				'name': 'upset.manta.test.nameservice_broken0',
				'agent': 'svc-nameservice-0',
				'config': {
				    'env': {
					'complex': 'snpp',
					'sector': '7G'
				    }
				}
			    }),
			    makeProbe({
				'group': 'deployed-group-uuid-3',
				'name': 'upset.manta.test.all0',
				'agent': 'svc-nameservice-0'
			    }),
			    makeProbe({
			        'group': 'deployed-group-uuid-svc-nameservice',
				'name': 'upset.manta.test.nameservice0',
				'agent': 'svc-nameservice-0'
			    })
			];
			mock.config.agentprobes['svc-nameservice-1'] = [
			    makeProbe({
			        'group': 'deployed-group-uuid-1',
				'name': 'upset.manta.test.nameservice_broken0',
				'agent': 'svc-nameservice-1',
				'config': {
				    'env': {
					'complex': 'snpp',
					'sector': '7G'
				    }
				}
			    }),
			    makeProbe({
				'group': 'deployed-group-uuid-3',
				'name': 'upset.manta.test.all0',
				'agent': 'svc-nameservice-1'
			    }),
			    makeProbe({
			        'group': 'deployed-group-uuid-svc-nameservice',
				'name': 'upset.manta.test.nameservice0',
				'agent': 'svc-nameservice-1'
			    })
			];
			mock.config.agentprobes['svc-nameservice-2'] = [
			    makeProbe({
			        'group': 'deployed-group-uuid-1',
				'name': 'upset.manta.test.nameservice_broken0',
				'agent': 'svc-nameservice-2',
				'config': {
				    'env': {
					'complex': 'snpp',
					'sector': '7G'
				    }
				}
			    }),
			    makeProbe({
				'group': 'deployed-group-uuid-3',
				'name': 'upset.manta.test.all0',
				'agent': 'svc-nameservice-2'
			    }),
			    makeProbe({
			        'group': 'deployed-group-uuid-svc-nameservice',
				'name': 'upset.manta.test.nameservice0',
				'agent': 'svc-nameservice-2'
			    })
			];

			mock.config.agentprobes['svc-jobsupervisor-0'] = [
			    makeProbe({
				'group': 'deployed-group-uuid-3',
				'name': 'upset.manta.test.all0',
				'agent': 'svc-jobsupervisor-0'
			    }),
			    makeProbe({
				'group': 'deployed-group-uuid-svc-' +
				    'jobsupervisor',
				'name': 'upset.manta.test.jobsupervisor0',
				'agent': 'svc-jobsupervisor-0'
			    })
			];
			mock.config.agentprobes['svc-jobsupervisor-1'] = [
			    makeProbe({
				'group': 'deployed-group-uuid-3',
				'name': 'upset.manta.test.all0',
				'agent': 'svc-jobsupervisor-1'
			    }),
			    makeProbe({
				'group': 'deployed-group-uuid-svc-' +
				     'jobsupervisor',
				'name': 'upset.manta.test.jobsupervisor0',
				'agent': 'svc-jobsupervisor-1'
			    })
			];

			mock.config.agentprobes['server-uuid-0'] = [
			    makeProbe({
				'group': 'deployed-group-uuid-2',
				'name': 'upset.manta.test.global0',
				'agent': 'server-uuid-0'
			    })
			];
			mock.config.agentprobes['server-uuid-1'] = [
			    makeProbe({
				'group': 'deployed-group-uuid-2',
				'name': 'upset.manta.test.global0',
				'agent': 'server-uuid-1'
			    })
			];

			loadDeployedForConfig(mock, dc, function (cfg) {
				dc.ctp_deployed_full = cfg;
				subcallback();
			});
		},

		/*
		 * To the previous configuration, add the legacy probe group,
		 * the operator-created probe group, the probes for these, and
		 * the probe that has no probe group, and the probe that has a
		 * group that doesn't exist.
		 */
		function basicDcExtraProbes(subcallback) {
			var dc = testParamsByDcConfig.cfg_basic;
			var nsagent = dc.ctp_instances_by_svcname[
			    'nameservice'][0];

			mock.config.groups.push({
			    'uuid': 'operator-group-1',
			    'name': 'operator-created group 1',
			    'user': account,
			    'disabled': false,
			    'contacts': [ 'operator-contact-1' ]
			});
			mock.config.groups.push({
			    'uuid': 'nameservice-alert-uuid',
			    'name': 'nameservice-alert',
			    'user': account,
			    'disabled': false,
			    'contacts': [ 'major_contact' ]
			});

			/* probe for the operator's custom group */
			mock.config.agentprobes['server-uuid-0'].push(
			    makeProbe({
			        'name': 'operator-1',
			        'group': 'operator-group-1'
			    }));
			/* probe having no group at all */
			mock.config.agentprobes['server-uuid-0'].push(
			    makeProbe({
				'name': 'rogue'
			    }));
			/* probe for group that's missing */
			mock.config.agentprobes['server-uuid-0'].push(
			    makeProbe({
				'name': 'badgroup',
				'group': 'no-such-group'
			    }));
			/* probe for the nameservice's legacy group */
			mock.config.agentprobes[nsagent].push(makeProbe({
			    'name': 'nameservice-legacy',
			    'group': 'nameservice-alert-uuid',
			    'agent': nsagent
			}));

			loadDeployedForConfig(mock, dc, function (cfg) {
				dc.ctp_deployed_extra = cfg;
				subcallback();
			});
		},

		/*
		 * From the previous configuration, remove some of the probes
		 * that we would normally deploy automatically.  This represents
		 * a partially deployed configuration and tests that the
		 * software does the right thing for smaller, incremental
		 * updates.
		 *
		 * It would be ideal in this test case to also add a probe for
		 * an existing, automatically-managed probe group to a zone that
		 * no longer exists so that we could test cleaning these up.
		 * However, by the way we've designed this mechanism, we won't
		 * clean these up, and in general there's no way for us to even
		 * identify such probes unless they happen to be in the first
		 * 1,000 that would be returned from Amon.
		 */
		function basicDcPartialProbes(subcallback) {
			var dc = testParamsByDcConfig.cfg_basic;
			var groupToRm = 'deployed-group-uuid-svc-nameservice';
			var nsagent = dc.ctp_instances_by_svcname[
			    'nameservice'][0];

			/*
			 * Remove one of the deployed probe groups and its
			 * probes.
			 */
			mock.config.groups = mock.config.groups.filter(
			    function (g) {
				return (g.uuid != groupToRm);
			    });
			jsprim.forEachKey(mock.config.agentprobes,
			    function (agentuuid, agentprobes) {
				if (dc.ctp_instances_by_svcname[
				    'nameservice'].indexOf(agentuuid) == -1) {
					return;
				}

				mock.config.agentprobes[agentuuid] =
				    agentprobes.filter(function (p) {
					return (p.group != groupToRm);
				    });
			    });

			/*
			 * Remove one of the deployed probes for another probe
			 * group.
			 */
			mock.config.agentprobes[nsagent] =
			    mock.config.agentprobes[nsagent].filter(
			    function (p) {
				return (p.group != 'deployed-group-uuid-1');
			    });

			loadDeployedForConfig(mock, dc, function (cfg) {
				dc.ctp_deployed_partial = cfg;
				subcallback();
			});
		}

	], function (err) {
		assertplus.ok(!err);
		callback();
	});
}

/*
 * Given the mock Amon configuration, load deployed probe groups and probes.
 */
function loadDeployedForConfig(mock, dcconfig, callback)
{
	var components;

	assertplus.object(dcconfig.ctp_servers);
	components = [];
	dcconfig.ctp_servers.forEach(function (s) {
		components.push({ 'type': 'cn', 'uuid': s });
	});
	jsprim.forEachKey(dcconfig.ctp_instances, function (_, instance) {
		if (!instance.inst_local) {
			return;
		}

		components.push({ 'type': 'vm', 'uuid': instance.inst_uuid });
	});

	alarms.amonLoadProbeGroups({
	    'amon': mock.client,
	    'account': account
	}, function (err, config) {
		assertplus.ok(!err);
		assertplus.ok(config);
		alarms.amonLoadComponentProbes({
		    'amonRaw': mock.clientRaw,
		    'amoncfg': config,
		    'components': components,
		    'concurrency': 3
		}, function (probeError) {
			assertplus.ok(!probeError);
			callback(config);
		});
	});
}

function generateTestCases()
{
	var ngroupsfull, nprobesfull;

	testCases = [];

	/*
	 * There are three non-"each" templates, plus an "each" template
	 * that generates a group for each service that supports probes.
	 */
	ngroupsfull = 3 + services.mSvcNamesProbes.length;

	/*
	 * We've got:
	 *
	 *   - 3 "nameservice" probes for the "nameservice" template
	 *   - 2 "global" probes for the "global" template
	 *   - 3 "nameservice" probes for the "each" template
	 *   - 2 "jobsupervisor" probes for the "each" template
	 *   - 5 probes for the "all" template
	 *
	 * totalling 15 probes.
	 */
	nprobesfull = 15;

	testCases.push({
	    'name': 'empty DC, undeployed, configure with no metadata',
	    'metadata': emptyMetadata,
	    'dcConfig': testParamsByDcConfig.cfg_empty,
	    'deployed': 'none',
	    'unconfigure': false,
	    'verify': function (plan) {
		assertplus.ok(!plan.needsChanges());
		assertplus.strictEqual(plan.mup_probes_remove.length, 0);
		assertplus.strictEqual(plan.mup_groups_remove.length, 0);
		assertplus.strictEqual(plan.mup_groups_add.length, 0);
		assertplus.strictEqual(plan.mup_probes_add.length, 0);
	    }
	});

	testCases.push({
	    'name': 'empty DC, undeployed, configure (add groups only)',
	    'metadata': basicMetadata,
	    'dcConfig': testParamsByDcConfig.cfg_empty,
	    'deployed': 'none',
	    'unconfigure': false,
	    'verify': function (plan) {
		assertplus.ok(plan.needsChanges());
		assertplus.strictEqual(plan.mup_probes_remove.length, 0);
		assertplus.strictEqual(plan.mup_groups_remove.length, 0);
		assertplus.strictEqual(plan.mup_groups_add.length, ngroupsfull);
		assertplus.strictEqual(plan.mup_probes_add.length, 0);
	    }
	});

	testCases.push({
	    'name': 'empty DC, undeployed, unconfigure (no changes)',
	    'metadata': basicMetadata,
	    'dcConfig': testParamsByDcConfig.cfg_empty,
	    'deployed': 'none',
	    'unconfigure': true,
	    'verify': function (plan) {
		assertplus.ok(!plan.needsChanges());
		assertplus.strictEqual(plan.mup_probes_remove.length, 0);
		assertplus.strictEqual(plan.mup_groups_remove.length, 0);
		assertplus.strictEqual(plan.mup_groups_add.length, 0);
		assertplus.strictEqual(plan.mup_probes_add.length, 0);
	    }
	});

	testCases.push({
	    'name': 'basic DC, undeployed, configure with no metadata',
	    'metadata': emptyMetadata,
	    'dcConfig': testParamsByDcConfig.cfg_basic,
	    'deployed': 'none',
	    'unconfigure': false,
	    'verify': function (plan) {
		assertplus.ok(!plan.needsChanges());
		assertplus.strictEqual(plan.mup_probes_remove.length, 0);
		assertplus.strictEqual(plan.mup_groups_remove.length, 0);
		assertplus.strictEqual(plan.mup_groups_add.length, 0);
		assertplus.strictEqual(plan.mup_probes_add.length, 0);
	    }
	});

	testCases.push({
	    'name': 'basic DC, undeployed, configure (many changes)',
	    'metadata': basicMetadata,
	    'dcConfig': testParamsByDcConfig.cfg_basic,
	    'deployed': 'none',
	    'unconfigure': false,
	    'verify': function (plan) {
		assertplus.ok(plan.needsChanges());
		assertplus.strictEqual(plan.mup_probes_remove.length, 0);
		assertplus.strictEqual(plan.mup_groups_remove.length, 0);
		assertplus.strictEqual(plan.mup_groups_add.length, ngroupsfull);
		assertplus.strictEqual(plan.mup_probes_add.length, nprobesfull);
	    }
	});

	testCases.push({
	    'name': 'basic DC, undeployed, unconfigure (no changes)',
	    'metadata': basicMetadata,
	    'dcConfig': testParamsByDcConfig.cfg_basic,
	    'deployed': 'none',
	    'unconfigure': true,
	    'verify': function (plan) {
		assertplus.ok(!plan.needsChanges());
		assertplus.strictEqual(plan.mup_probes_remove.length, 0);
		assertplus.strictEqual(plan.mup_groups_remove.length, 0);
		assertplus.strictEqual(plan.mup_groups_add.length, 0);
		assertplus.strictEqual(plan.mup_probes_add.length, 0);
	    }
	});

	testCases.push({
	    'name': 'basic DC, deployed, configure with no metadata',
	    'metadata': emptyMetadata,
	    'dcConfig': testParamsByDcConfig.cfg_basic,
	    'deployed': 'full',
	    'unconfigure': true,
	    'verify': function (plan) {
		assertplus.ok(plan.needsChanges());
		assertplus.strictEqual(plan.mup_probes_remove.length,
		    nprobesfull);
		assertplus.strictEqual(plan.mup_groups_remove.length,
		    ngroupsfull);
		assertplus.strictEqual(plan.mup_groups_add.length, 0);
		assertplus.strictEqual(plan.mup_probes_add.length, 0);
	    }
	});

	testCases.push({
	    'name': 'basic DC, deployed, configure (no changes)',
	    'metadata': basicMetadata,
	    'dcConfig': testParamsByDcConfig.cfg_basic,
	    'deployed': 'full',
	    'unconfigure': false,
	    'verify': function (plan) {
		assertplus.ok(!plan.needsChanges());
		assertplus.strictEqual(plan.mup_probes_remove.length, 0);
		assertplus.strictEqual(plan.mup_groups_remove.length, 0);
		assertplus.strictEqual(plan.mup_groups_add.length, 0);
		assertplus.strictEqual(plan.mup_probes_add.length, 0);
	    }
	});

	testCases.push({
	    'name': 'basic DC, deployed, unconfigure (many changes)',
	    'metadata': basicMetadata,
	    'dcConfig': testParamsByDcConfig.cfg_basic,
	    'deployed': 'full',
	    'unconfigure': true,
	    'verify': function (plan) {
		assertplus.ok(plan.needsChanges());
		assertplus.strictEqual(plan.mup_probes_remove.length,
		    nprobesfull);
		assertplus.strictEqual(plan.mup_groups_remove.length,
		    ngroupsfull);
		assertplus.strictEqual(plan.mup_groups_add.length, 0);
		assertplus.strictEqual(plan.mup_probes_add.length, 0);
	    }
	});

	testCases.push({
	    'name': 'basic DC, deployed with extra, configure',
	    'metadata': basicMetadata,
	    'dcConfig': testParamsByDcConfig.cfg_basic,
	    'deployed': 'extra',
	    'unconfigure': false,
	    'verify': function (plan) {
		assertplus.ok(plan.needsChanges());
		/* We expect to remove only the legacy group and probe. */
		assertplus.strictEqual(plan.mup_probes_remove.length, 1);
		assertplus.strictEqual(plan.mup_groups_remove.length, 1);
		/* We don't expect to add anything. */
		assertplus.strictEqual(plan.mup_groups_add.length, 0);
		assertplus.strictEqual(plan.mup_probes_add.length, 0);
	    }
	});

	testCases.push({
	    'name': 'basic DC, deployed with extra, unconfigure',
	    'metadata': basicMetadata,
	    'dcConfig': testParamsByDcConfig.cfg_basic,
	    'deployed': 'extra',
	    'unconfigure': true,
	    'verify': function (plan) {
		assertplus.ok(plan.needsChanges());
		/*
		 * We expect to remove the legacy group and probe, plus the
		 * usual ones.
		 */
		assertplus.strictEqual(plan.mup_probes_remove.length,
		    1 + nprobesfull);
		assertplus.strictEqual(plan.mup_groups_remove.length,
		    1 + ngroupsfull);
		/* We don't expect to add anything. */
		assertplus.strictEqual(plan.mup_groups_add.length, 0);
		assertplus.strictEqual(plan.mup_probes_add.length, 0);
	    }
	});

	testCases.push({
	    'name': 'basic DC, partially deployed, configure',
	    'metadata': basicMetadata,
	    'dcConfig': testParamsByDcConfig.cfg_basic,
	    'deployed': 'partial',
	    'unconfigure': false,
	    'verify': function (plan) {
		assertplus.ok(plan.needsChanges());

		/* We expect to remove the legacy probe group and its probe. */
		assertplus.strictEqual(plan.mup_groups_remove.length, 1);
		assertplus.strictEqual(plan.mup_probes_remove.length, 1);

		/*
		 * We expect to add one group that was missing, plus one probe
		 * for each nameservice for the group that was missing, plus
		 * one additional probe for the probe that was missing.
		 */
		assertplus.strictEqual(plan.mup_groups_add.length, 1);
		assertplus.strictEqual(plan.mup_probes_add.length, 4);
	    }
	});

	testCases.push({
	    'name': 'basic DC, partially deployed, unconfigure',
	    'metadata': basicMetadata,
	    'dcConfig': testParamsByDcConfig.cfg_basic,
	    'deployed': 'partial',
	    'unconfigure': true,
	    'verify': function (plan) {
		assertplus.ok(plan.needsChanges());

		/*
		 * We expect to remove all of the usual groups except for the
		 * one that was already missing (because this was a partial
		 * deployment to begin with), plus the legacy one.
		 */
		assertplus.strictEqual(plan.mup_groups_remove.length,
		    ngroupsfull);

		/*
		 * Similarly, we expect to remove all of the usual probes except
		 * for the four that were already missing (because this was a
		 * partial deployment), plus the legacy one.
		 */
		assertplus.strictEqual(plan.mup_probes_remove.length,
		    nprobesfull - 3);
		assertplus.strictEqual(plan.mup_groups_add.length, 0);
		assertplus.strictEqual(plan.mup_probes_add.length, 0);
	    }
	});
}

function runTestCase(tc)
{
	var dc, plan;

	console.error(tc.name);

	dc = tc.dcConfig;
	assertplus.ok(tc.deployed == 'none' || tc.deployed == 'full' ||
	    tc.deployed == 'extra' || tc.deployed == 'partial');
	plan = alarms.amonUpdatePlanCreate({
	    'account': account,
	    'contactsBySeverity': contactsBySeverity,
	    'instances': dc.ctp_instances,
	    'instancesBySvc': dc.ctp_instances_by_svcname,
	    'deployed': tc.deployed == 'none' ?  dc.ctp_deployed_none :
		tc.deployed == 'extra' ? dc.ctp_deployed_extra :
		tc.deployed == 'partial' ? dc.ctp_deployed_partial :
		dc.ctp_deployed_full,
	    'metadata': tc.metadata,
	    'unconfigure': tc.unconfigure
	});
	assertplus.ok(!(plan instanceof Error));
	tc.verify(plan);
}

function makeProbe(params)
{
	var agent, machine;

	agent = params.agent || 'server-uuid-0';
	machine = params.machine || agent;

	return ({
	    'uuid': 'probe-uuid-' + params.name,
	    'name': 'probe-name-' + params.name,
	    'group': params.group || null,
	    'user': account,
	    'type': 'cmd',
	    'config': params.config || {},
	    'agent': agent,
	    'machine': machine,
	    'groupEvents': true
	});
}

main();
