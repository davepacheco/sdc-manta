/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * lib/alarms/amon_config_update.js: facilities for updating a deployed set of
 * Amon probes and probe groups.  This module builds on the facilities provided
 * by amon_config.js.
 */

var assertplus = require('assert-plus');
var jsprim = require('jsprim');
var vasync = require('vasync');
var VError = require('verror');
var MultiError = VError.MultiError;

var fprintf = require('extsprintf').fprintf;
var services = require('../services');

var alarm_metadata = require('./metadata');
var alarm_config = require('./amon_config');

/* Exported interface */
exports.amonUpdatePlanCreate = amonUpdatePlanCreate;
exports.amonUpdatePlanSummarize = amonUpdatePlanSummarize;
exports.amonUpdatePlanApply = amonUpdatePlanApply;

/*
 * Amon update plan
 *
 * The MantaAmonUpdatePlan class represents a set of probes and probe groups to
 * be removed and a set of probes and probe groups to be added in order to
 * update the Amon configuration for the Manta service.
 */
function MantaAmonUpdatePlan()
{
	/*
	 * The actual plan is represented by the lists of probes and groups to
	 * be added and removed.
	 */

	this.mup_probes_remove = []; 	/* probes to remove */
	this.mup_groups_remove = []; 	/* probe groups to remove */
	this.mup_groups_add = []; 	/* groups to add */
	this.mup_probes_add = []; 	/* probes to add */

	/*
	 * Statistics kept about the update
	 */

	/* count of probe groups that were deployed and wanted */
	this.mup_ngroupsmatch = 0;
	/* count of probes that were deployed and wanted */
	this.mup_nprobesmatch = 0;
	/* count of probe groups that were deployed, unwanted, but kept */
	this.mup_ngroupsignore = 0;

	/*
	 * Counts of probes added and removed and agents affected, by group id.
	 */

	this.mup_nadd_bygroup = {};
	this.mup_nremove_bygroup = {};
	this.mup_agents_bygroup = {};

	/* warning messages to display to the operator */
	this.mup_warnings = [];

	/*
	 * MantaAmonConfig objects used to generate this plan.
	 */
	this.mup_deployed = null;	/* found configuration */
	this.mup_wanted = null;		/* wanted configuration */
}

/*
 * This is one of only two methods that may be called from outside of this file.
 * Returns true if the update plan indicates that any changes need to be made.
 */
MantaAmonUpdatePlan.prototype.needsChanges = function ()
{
	return (this.mup_groups_remove.length > 0 ||
	    this.mup_probes_remove.length > 0 ||
	    this.mup_probes_add.length > 0 ||
	    this.mup_groups_add.length > 0);
};

/*
 * This is one of only two methods that may be called from outside of this file.
 * Returns a list of Error objects describing problems found constructing the
 * update plan.  These are generally non-fatal, but should be presented to an
 * operator.
 */
MantaAmonUpdatePlan.prototype.warnings = function ()
{
	return (this.mup_warnings.slice(0));
};

MantaAmonUpdatePlan.prototype.probeUpdate = function (probe, counters, list)
{
	var groupid, agent;

	assertplus.string(probe.p_groupid,
	    'probe has no group id (adding and removing probes ' +
	    'without groups is not supported');
	groupid = probe.p_groupid;
	assertplus.string(probe.p_agent);
	agent = probe.p_agent;

	if (!counters.hasOwnProperty(groupid)) {
		counters[groupid] = 0;
	}
	counters[groupid]++;

	if (!this.mup_agents_bygroup.hasOwnProperty(groupid)) {
		this.mup_agents_bygroup[groupid] = {};
	}
	this.mup_agents_bygroup[groupid][agent] = true;

	list.push(probe);
};

MantaAmonUpdatePlan.prototype.groupAdd = function groupAdd(group)
{
	this.mup_groups_add.push(group);
};

MantaAmonUpdatePlan.prototype.groupRemove = function groupRemove(group)
{
	this.mup_groups_remove.push(group);
};

MantaAmonUpdatePlan.prototype.probeAdd = function probeAdd(probe)
{
	this.probeUpdate(probe, this.mup_nadd_bygroup, this.mup_probes_add);
};

MantaAmonUpdatePlan.prototype.probeRemove = function probeRemove(probe)
{
	this.probeUpdate(probe, this.mup_nremove_bygroup,
	    this.mup_probes_remove);
};

/*
 * Given information about a current deployment, determine the set of updates to
 * Amon necessary to update the configuration to what it should be.  See the
 * block comment at the top of this file for a discussion of the goals and
 * constraints of this operation.
 *
 * Named arguments:
 *
 *     vms		object mapping VMAPI vm uuids to VMAPI VM objects for
 *     			all active VMs in this deployment
 *
 *     cns		object mapping CNAPI server uuids to CNAPI server
 *     			objects for all CNs hosting the VMs in "vms"
 *
 *     sapi_instances	object mapping SAPI instance uuids to SAPI objects for
 *     			all VMs in "vms"
 *
 *     account  	Triton account uuid to use for wanted Amon probes
 *
 *     contacts		Array of Amon contact methods (strings) to use
 *
 *     deployed		MantaAmonConfig object describing the set of probes and
 *     			probe groups curently deployed
 *
 *     metadata		MantaAmonMetadata object describing the set of probes
 *     			and probe groups that should be deployed
 *
 *     unconfigure	if specified, then all probes and probe groups should be
 *     			removed, rather than updated to what would normally be
 *     			configured
 *
 * This function returns either an Error (on failure) or a MantaAmonUpdatePlan.
 */
function amonUpdatePlanCreate(args)
{
	var deployed, metadata, wanted, rv;

	assertplus.object(args, 'args');
	assertplus.object(args.vms, 'args.vms');
	assertplus.object(args.cns, 'args.cns');
	assertplus.object(args.sapi_instances, 'args.sapi_instances');
	assertplus.string(args.account, 'args.account');
	assertplus.arrayOfString(args.contacts, 'args.contacts');
	assertplus.object(args.deployed, 'args.deployed');
	assertplus.ok(args.deployed instanceof alarm_config.MantaAmonConfig);
	assertplus.object(args.metadata, 'args.metadata');
	assertplus.bool(args.unconfigure, 'args.unconfigure');

	deployed = args.deployed;
	metadata = args.metadata;
	wanted = amonGenerateWanted({
	    'account': args.account,
	    'contacts': args.contacts,
	    'vms': args.vms,
	    'cns': args.cns,
	    'sapi_instances': args.sapi_instances,
	    'metadata': metadata
	});

	if (wanted instanceof Error) {
		return (new VError(wanted,
		    'generating wanted amon configuration'));
	}

	rv = new MantaAmonUpdatePlan();
	rv.mup_deployed = deployed;
	rv.mup_wanted = wanted;

	/*
	 * We don't expect to deploy any probes that don't have probe groups
	 * associated with them.
	 */
	wanted.eachOrphanProbe(function (p) {
		throw (new VError(
		    'unexpected orphan probe in "wanted" set'));
	});

	if (args.unconfigure) {
		amonUpdatePlanCreateUnconfigure({
		    'metadata': metadata,
		    'plan': rv
		});

		return (rv);
	}

	/*
	 * Iterate the "wanted" set and create any probe groups and probes that
	 * are missing from the "deployed" set.
	 */
	wanted.eachProbeGroup(function iterWProbeGroup(wpg) {
		var pgname, dpg, probesByAgent;

		pgname = wpg.pg_name;
		dpg = deployed.probeGroupForName(pgname);
		if (dpg !== null) {
			rv.mup_ngroupsmatch++;
			if (wpg.pg_user != dpg.pg_user ||
			    !jsprim.deepEqual(wpg.pg_contacts.slice(0).sort(),
			    dpg.pg_contacts.slice(0).sort())) {
				/*
				 * This case shouldn't really be possible, but
				 * we may as well sanity-check the configuration
				 * and raise a red flag if we find something
				 * unexpected.
				 */
				rv.mup_warnings.push(new VError('probe group ' +
				    'with name "%s" (deployed with uuid ' +
				    '"%s"): unexpected "user" or "contacts"',
				    pgname, dpg.pg_uuid));
			}
		} else {
			rv.groupAdd(wpg);
		}

		/*
		 * In order to tell which probes need to be added and removed,
		 * we need to be able to match up probes that are deployed with
		 * probes that are wanted.  For our purposes, we will consider
		 * a deployed probe and a wanted probe equivalent if they have
		 * the same value for all of the immutable, configurable fields
		 * that we expect not to change: the probe group name, "type",
		 * "config", "agent", and "machine".  We'll warn if "contacts"
		 * or "groupEvents" don't match what we expect.  If a new
		 * version of the software changes the configuration (e.g., by
		 * changing the bash script executed or the frequency of
		 * execution), the deployed and wanted probes won't match, and
		 * we'll end up removing the deployed one and adding the wanted
		 * one.
		 *
		 * In order to keep this search relatively efficient, we first
		 * build a list of probes for each agent for this probe group.
		 * This should generally correspond to the list of checks
		 * configured in the local metadata.  That's usually just one
		 * probe, but might be a handful.
		 */
		probesByAgent = {};
		if (deployed.hasProbeGroup(pgname)) {
			deployed.eachProbeGroupProbe(pgname,
			    function iterDProbe(p) {
				if (!probesByAgent.hasOwnProperty(p.p_agent)) {
					probesByAgent[p.p_agent] = [];
				}

				probesByAgent[p.p_agent].push(p);
			    });
		}

		wanted.eachProbeGroupProbe(pgname, function iterWProbe(wp) {
			var agent, dprobes, i, dp;

			/*
			 * Try to find a match for this wanted probe in the list
			 * of deployed probes for the same agent.
			 */
			agent = wp.p_agent;
			if (!probesByAgent.hasOwnProperty(agent)) {
				rv.probeAdd(wp);
				return;
			}

			dprobes = probesByAgent[agent];
			for (i = 0; i < dprobes.length; i++) {
				dp = dprobes[i];
				if (dp.p_type == wp.p_type &&
				    jsprim.deepEqual(dp.p_config,
				    wp.p_config) &&
				    dp.p_machine == wp.p_machine) {
					break;
				}
			}

			if (i == dprobes.length) {
				rv.probeAdd(wp);
				return;
			}

			/*
			 * We've found a match, but if it differs in fields we
			 * would never expect to change, warn the administrator.
			 */
			rv.mup_nprobesmatch++;
			if (wp.p_group_events != dp.p_group_events ||
			    (dp.p_contacts === null &&
			    wp.p_contacts !== null) ||
			    (dp.p_contacts !== null &&
			    wp.p_contacts === null) ||
			    (dp.p_contacts !== null &&
			    !jsprim.deepEqual(dp.p_contacts.slice(0).sort(),
			    wp.p_contacts.slice(0).sort()))) {
				rv.mup_warnings.push(new VError('probe group ' +
				    '"%s" (deployed with uuid "%s"): probe ' +
				    'for agent "%s": found match that ' +
				    'differs in "groupEvents" or "contacts"',
				    pgname, dpg.pg_uuid, agent));
			}


			/*
			 * Since we've found a match, there's no action to take
			 * for this probe.  Remove the entry for the deployed
			 * probe so that we can identify all of the deployed
			 * probes that weren't wanted by just iterating what's
			 * left.  This also prevents us from re-using the same
			 * deployed probe to match multiple wanted probes, but
			 * that shouldn't be possible anyway.
			 */
			if (dprobes.length == 1) {
				assertplus.equal(i, 0);
				delete (probesByAgent[agent]);
			} else {
				dprobes.splice(i, 1);
			}
		});

		/*
		 * Remove whatever deployed probes did not match any of the
		 * wanted probes.  We only create each agent's array when we're
		 * going to add to it, and we delete the array entirely when we
		 * would remove its last element, so each array we find here
		 * should be non-empty.
		 */
		jsprim.forEachKey(probesByAgent, function (agent, dprobes) {
			assertplus.ok(dprobes.length > 0);
			dprobes.forEach(function (p) {
				rv.probeRemove(p);
			});
		});
	});

	/*
	 * Now iterate the "deployed" set and remove probes and probe groups
	 * that are both unwanted and eligible for removal.
	 */
	deployed.eachProbeGroup(function iterDProbeGroup(dpg) {
		var pgname;

		pgname = dpg.pg_name;
		if (wanted.probeGroupForName(pgname) !== null) {
			/*
			 * This group was handled when we iterated the wanted
			 * probe groups.
			 */
			return;
		}

		if (!metadata.probeGroupIsRemovable(pgname)) {
			rv.mup_ngroupsignore++;
			return;
		}

		rv.groupRemove(dpg);
		deployed.eachProbeGroupProbe(pgname, function iterDProbe(p) {
			rv.probeRemove(p);
		});
	});

	return (rv);
}

/*
 * Given information about deployed VMs and CNs and the local metadata about
 * which probes are to be deployed to which types of components, construct a
 * MantaAmonConfig that represents the desired set of Amon configuration.
 */
function amonGenerateWanted(args)
{
	var contacts, zonesBySvcName, wanted, k, vm;

	assertplus.object(args, 'args');
	assertplus.object(args.vms, 'args.vms');
	assertplus.object(args.cns, 'args.cns');
	assertplus.object(args.sapi_instances, 'args.sapi_instances');
	assertplus.string(args.account, 'args.account');
	assertplus.arrayOfString(args.contacts, 'args.contacts');
	assertplus.object(args.metadata, 'args.metadata');

	contacts = args.contacts.slice(0);
	wanted = new alarm_config.MantaAmonConfig();

	/*
	 * Begin by classifying all VMs and CNs according to their service name.
	 * XXX This probably should use SAPI metadata rather than tags on the
	 * VM.  That would eliminate having to know about the special case of
	 * "compute", and it would also avoid having to grok VMAPI-specific
	 * schema.
	 */
	zonesBySvcName = {};
	services.mSvcNames.forEach(function (s) {
		zonesBySvcName[s] = [];
	});
	for (k in args.vms) {
		vm = args.vms[k];
		assertplus.object(vm, 'vm');
		assertplus.object(vm.tags, 'vm "' + k + '" tags');

		if (!vm.tags.hasOwnProperty('manta_role')) {
			continue;
		}

		assertplus.string(vm.tags.manta_role);
		if (vm.tags.manta_role == 'compute') {
			/* XXX see above */
			continue;
		}

		if (!zonesBySvcName.hasOwnProperty(vm.tags.manta_role)) {
			return (new VError('vm "%s" has unknown role "%s"',
			    k, vm.tags.manta_role));
		}

		zonesBySvcName[vm.tags.manta_role].push(k);
	}

	/*
	 * Now walk the metadata and generate the appropriate probes and probe
	 * groups.
	 */
	args.metadata.eachTemplate(function iterMetadataEvent(pt) {
		amonGenerateWantedTemplate({
		    'vms': args.vms,
		    'cns': args.cns,
		    'sapi_instances': args.sapi_instances,
		    'account': args.account,
		    'contacts': contacts,
		    'wanted': wanted,
		    'zonesBySvcName': zonesBySvcName,
		    'probeTemplate': pt
		});
	});

	return (wanted);
}

function amonGenerateWantedTemplate(args)
{
	var events, eventForSvc;
	var zonesBySvcName, pt, wanted;

	assertplus.object(args, 'args');
	assertplus.object(args.vms, 'args.vms');
	assertplus.object(args.cns, 'args.cns');
	assertplus.object(args.sapi_instances, 'args.sapi_instances');
	assertplus.string(args.account, 'args.account');
	assertplus.arrayOfString(args.contacts, 'args.contacts');
	assertplus.object(args.wanted, 'args.wanted');
	assertplus.ok(args.wanted instanceof alarm_config.MantaAmonConfig);
	assertplus.object(args.probeTemplate, 'args.probeTemplate');
	assertplus.object(args.zonesBySvcName, 'args.zonesBySvcName');

	zonesBySvcName = args.zonesBySvcName;
	pt = args.probeTemplate;
	wanted = args.wanted;

	eventForSvc = {};
	if (pt.pt_scope.ptsc_service == 'each') {
		assertplus.ok(pt.pt_aliases.length > 0);
		events = [];
		pt.pt_aliases.forEach(function (alias) {
			events.push(alias.pta_event);
			eventForSvc[alias.pta_service] =
			    alias.pta_event;
		});
	} else if (pt.pt_scope.ptsc_service == 'all') {
		assertplus.ok(pt.pt_aliases.length === 0);
		events = [ pt.pt_event ];
		jsprim.forEachKey(zonesBySvcName, function (svcname) {
			eventForSvc[svcname] = pt.pt_event;
		});
	} else if (pt.pt_scope.ptsc_check_from !== null) {
		assertplus.ok(pt.pt_aliases.length === 0);
		events = [ pt.pt_event ];
		eventForSvc[pt.pt_scope.ptsc_check_from] = pt.pt_event;
	} else {
		assertplus.ok(pt.pt_aliases.length === 0);
		events = [ pt.pt_event ];
		eventForSvc[pt.pt_scope.ptsc_service] = pt.pt_event;
	}

	events.forEach(function (eventName) {
		var pgname = alarm_metadata.probeGroupNameForTemplate(
		    pt, eventName);
		/*
		 * XXX it's a little dicey to fake up the probe group uuid like
		 * this.
		 */
		wanted.addProbeGroup({
		    'uuid': pgname,
		    'name': pgname,
		    'user': args.account,
		    'contacts': args.contacts,
		    'disabled': false
		});
	});

	jsprim.forEachKey(eventForSvc, function (svcname, eventName) {
		var targets, checkers, probes, gzs;

		if (!zonesBySvcName.hasOwnProperty(svcname)) {
			/*
			 * We have no locally deployed zones for whatever
			 * service we would deploy these probes.  This is likely
			 * to happen if someone is deploying probes in a
			 * partially-deployed Manta, or if this is a
			 * multi-datacenter deployment where some services are
			 * only in a subset of datacenters.  There's nothing
			 * wrong with this; we just have no probes to deploy
			 * here.
			 */
			return;
		}

		checkers = zonesBySvcName[svcname];

		if (pt.pt_scope.ptsc_global) {
			/*
			 * If "global" was specified on the scope, then this
			 * probe targets not the zones for the specified
			 * service, but all global zones where this service
			 * runs.  There may be more than one instance on each
			 * CN, so we need to deduplicate this list.
			 */
			gzs = {};
			checkers.forEach(function (c) {
				assertplus.ok(args.vms.hasOwnProperty(c));
				assertplus.string(args.vms[c].server_uuid);
				gzs[args.vms[c].server_uuid] = true;
			});
			checkers = Object.keys(gzs);
		}

		if (pt.pt_scope.ptsc_check_from !== null) {
			if (!zonesBySvcName.hasOwnProperty(
			    pt.pt_scope.ptsc_check_from)) {
				return;
			}

			targets = zonesBySvcName[pt.pt_scope.ptsc_service];
			probes = [];
			checkers.forEach(function (c) {
				targets.forEach(function (t) {
					/*
					 * We might expect the machine to be the
					 * "target" here, but amon does not
					 * allow that for probes of type "cmd",
					 * and it's not all that meaningful here
					 * anyway.
					 * XXX can/should we change that?
					 */
					probes.push({
					    'agent': c,
					    'machine': c
					});
				});
			});
		} else {
			probes = checkers.map(function (c) {
				return ({
				    'agent': c,
				    'machine': c
				});
			});
		}

		probes.forEach(function (p) {
			pt.pt_checks.forEach(function (check, i) {
				var conf, probe, md;

				conf = jsprim.deepCopy(check.ptc_config);
				probe = {
				    'name': eventName + i,
				    'type': check.ptc_type,
				    'config': conf,
				    'agent': p.agent,
				    'machine': p.machine,
				    'group': alarm_metadata.
				        probeGroupNameForTemplate(
				        pt, eventName),
				    'groupEvents': true
				};

				/*
				 * Augment probe configurations with information
				 * from SAPI metadata.
				 */
				md = args.sapi_instances.hasOwnProperty(
				    p.machine) ?
				    args.sapi_instances[p.machine].metadata :
				    null;
				amonProbePopulateAutoEnv(probe, md);
				wanted.addProbe(probe);
			});
		});
	});
}

/*
 * For probes of type "cmd", we support a special configuration property called
 * "autoEnv".  The value of this property is a list of variable names.  We
 * populate the probe's shell environment with corresponding values from the
 * corresponding instance's SAPI metadata.
 */
function amonProbePopulateAutoEnv(probe, metadata)
{
	var vars;

	if (probe.type != 'cmd' ||
	    !probe.config.hasOwnProperty('autoEnv')) {
		return;
	}

	/*
	 * Remove the autoEnv property itself since Amon doesn't know anything
	 * about that.
	 */
	vars = probe.config.autoEnv;
	delete (probe.config.autoEnv);

	if (!probe.config.env) {
		probe.config.env = {};
	}

	vars.forEach(function (v) {
		/*
		 * XXX if this is missing, we should probably fail and emit an
		 * error.
		 */
		if (metadata !== null &&
		    metadata.hasOwnProperty(v) &&
		    typeof (metadata[v]) == 'string') {
			probe.config.env[v] = metadata[v];
		}
	});
}

/*
 * Flesh out an update plan that should unconfigure all of the probes and probe
 * groups that we would normally create.
 *
 * Named arguments:
 *
 *    plan	the update plan to flesh out
 *
 *    metadata	an instanceof MantaAmonMetadata
 */
function amonUpdatePlanCreateUnconfigure(args)
{
	var metadata, plan, wanted, deployed;

	assertplus.object(args, 'args');
	assertplus.object(args.metadata, 'args.metadata');
	assertplus.object(args.plan, 'args.plan');
	assertplus.ok(args.plan instanceof MantaAmonUpdatePlan);

	/*
	 * Unconfiguring isn't quite as simple as it seems.  We want to remove
	 * probe groups that we would normally have configured, as well as probe
	 * groups that we would normally remove (because they were created by
	 * older versions of the software).  But we want to leave in place any
	 * probes and probe groups created by an operator.
	 *
	 * It would be tempting to just create an empty "wanted" configuration
	 * and then run through the usual update plan generation process, but
	 * that process relies on knowing which probe groups are considered
	 * removable (see probeGroupIsRemovable()), and the definition of that
	 * differs for this case because our normal probe groups are removable
	 * when unconfiguring, but not otherwise.
	 */
	metadata = args.metadata;
	plan = args.plan;
	wanted = plan.mup_wanted;
	deployed = plan.mup_deployed;

	deployed.eachProbeGroup(function iterDProbeGroup(dpg) {
		var pgname, wpg;

		pgname = dpg.pg_name;
		wpg = wanted.probeGroupForName(pgname);
		if (wpg === null &&
		    !metadata.probeGroupIsRemovable(pgname)) {
			plan.mup_ngroupsignore++;
			return (null);
		}

		plan.groupRemove(dpg);
		deployed.eachProbeGroupProbe(pgname, function iterDProbe(p) {
			plan.probeRemove(p);
		});
	});
}

/*
 * Print a human-readable summary of an update plan.  Named arguments:
 *
 *    plan        The update plan to print
 *
 *    stream      Node stream to which to write the summary
 *
 *    metadata    An instance of MantaAmonMetadata, used to translate internal
 *		  names to more useful titles.
 *
 *    verbose     If true, print detailed information about probes changed
 *
 *    vms         Same as "vms" argument to amonUpdatePlanCreate().
 *		  XXX Not sure this belongs here.
 */
function amonUpdatePlanSummarize(args)
{
	var metadata, out, plan, verbose;
	var nagents, nprobes, ntotagents, ntotprobes, probes;
	var ntotbefore, ntotafter, delta;
	var countsByService = {};

	assertplus.object(args, 'args');
	assertplus.object(args.stream, 'args.stream');
	assertplus.object(args.metadata, 'args.metadata');
	assertplus.object(args.plan, 'args.plan');
	assertplus.ok(args.plan instanceof MantaAmonUpdatePlan);
	assertplus.object(args.vms, 'args.vms');
	assertplus.bool(args.verbose, 'args.verbose');

	metadata = args.metadata;
	out = args.stream;
	plan = args.plan;
	verbose = args.verbose;

	fprintf(out, 'Probe groups to REMOVE: ');
	if (plan.mup_groups_remove.length === 0) {
		fprintf(out, 'none\n');
	} else {
		fprintf(out, '\n');
		fprintf(out, '%7s %7s %s\n', 'NPROBES', 'NAGENTS', 'GROUP');
		ntotagents = 0;
		ntotprobes = 0;
		plan.mup_groups_remove.forEach(function (pg) {
			assertplus.ok(plan.mup_nremove_bygroup.hasOwnProperty(
			    pg.pg_uuid));
			assertplus.ok(!plan.mup_nadd_bygroup.hasOwnProperty(
			    pg.pg_uuid));
			nprobes = plan.mup_nremove_bygroup[pg.pg_uuid];

			assertplus.ok(plan.mup_agents_bygroup.hasOwnProperty(
			    pg.pg_uuid));
			nagents = Object.keys(plan.mup_agents_bygroup[
			    pg.pg_uuid]).length;

			fprintf(out, '%7d %7d %s\n',
			    nprobes, nagents, pg.pg_name);

			ntotprobes += nprobes;
			ntotagents += nagents;
		});
		fprintf(out, '%7d %7d TOTAL\n\n', ntotprobes, ntotagents);
	}

	fprintf(out, 'Probe groups to ADD: ');
	if (plan.mup_groups_add.length === 0) {
		fprintf(out, 'none\n');
	} else {
		fprintf(out, '\n');
		fprintf(out, '%7s %7s %s\n', 'NPROBES', 'NAGENTS', 'GROUP');
		ntotagents = 0;
		ntotprobes = 0;
		plan.mup_groups_add.forEach(function (pg) {
			var evt, ka, name;

			assertplus.ok(!plan.mup_nremove_bygroup.hasOwnProperty(
			    pg.pg_uuid));
			assertplus.ok(plan.mup_nadd_bygroup.hasOwnProperty(
			    pg.pg_uuid));
			nprobes = plan.mup_nadd_bygroup[pg.pg_uuid];

			assertplus.ok(plan.mup_agents_bygroup.hasOwnProperty(
			    pg.pg_uuid));
			nagents = Object.keys(plan.mup_agents_bygroup[
			    pg.pg_uuid]).length;

			name = pg.pg_name;
			evt = metadata.probeGroupEventName(pg.pg_name);
			if (evt !== null) {
				ka = metadata.eventKa(evt);
				if (ka !== null) {
					name = ka.ka_title;
				}
			}

			fprintf(out, '%7d %7d %s\n', nprobes, nagents, name);

			ntotprobes += nprobes;
			ntotagents += nagents;
		});
		fprintf(out, '%7d %7d TOTAL\n\n', ntotprobes, ntotagents);
	}

	fprintf(out, 'Count of probes by service\n');
	fprintf(out, '    %16s  %6s  %6s  %6s\n', 'SERVICE', 'BEFORE', 'AFTER',
	    'DELTA');
	services.mSvcNames.forEach(function (svcname) {
		/* XXX */
		if (svcname == 'marlin') {
			return;
		}

		countsByService[svcname] = { 'sc_before': 0, 'sc_after': 0 };
	});
	countsByService['GZs'] = { 'sc_before': 0, 'sc_after': 0 };

	ntotbefore = 0;
	plan.mup_deployed.eachProbeGroup(function (pg) {
		plan.mup_deployed.eachProbeGroupProbe(pg.pg_name, function (p) {
			var agent, svcname;

			assertplus.string(p.p_agent);
			agent = p.p_agent;
			if (args.vms.hasOwnProperty(agent)) {
				svcname = args.vms[agent].tags.manta_role;
			} else if (args.cns.hasOwnProperty(agent)) {
				svcname = 'GZs';
			} else {
				fprintf(out, 'warning: probe "%s": agent ' +
				    '"%s" is not a known VM or CN',
				    p.p_uuid, p.p_agent);
				return;
			}

			assertplus.ok(countsByService.hasOwnProperty(svcname));
			countsByService[svcname].sc_before++;
			ntotbefore++;
		});
	});

	/* XXX copy-paste! */
	ntotafter = 0;
	plan.mup_wanted.eachProbeGroup(function (pg) {
		plan.mup_wanted.eachProbeGroupProbe(pg.pg_name, function (p) {
			var agent, svcname;

			assertplus.string(p.p_agent);
			agent = p.p_agent;
			if (args.vms.hasOwnProperty(agent)) {
				svcname = args.vms[agent].tags.manta_role;
			} else if (args.cns.hasOwnProperty(agent)) {
				svcname = 'GZs';
			} else {
				fprintf(out, 'warning: probe "%s": agent ' +
				    '"%s" is not a known VM or CN',
				    p.p_uuid, p.p_agent);
				return;
			}

			assertplus.ok(countsByService.hasOwnProperty(svcname));
			countsByService[svcname].sc_after++;
			ntotafter++;
		});
	});

	jsprim.forEachKey(countsByService, function (svcname, counts) {
		delta = counts.sc_after - counts.sc_before;
		fprintf(out, '    %16s  %6d  %6d  %6s\n', svcname,
		    counts.sc_before, counts.sc_after,
		    delta > 0 ? '+' + delta : delta);
	});
	delta = ntotafter - ntotbefore;
	fprintf(out, '    %16s  %6d  %6d  %6s\n', 'TOTAL',
	    ntotbefore, ntotafter,
	    delta > 0 ? '+' + delta : delta);
	fprintf(out, '\n');

	if (verbose) {
		fprintf(out, 'Probes to ADD:\n');
		probes = plan.mup_probes_add.slice(0).sort(function (p1, p2) {
			var s1, s2, rv;

			s1 = args.vms[p1.p_agent].tags.manta_role;
			s2 = args.vms[p2.p_agent].tags.manta_role;
			rv = s1.localeCompare(s2);
			if (rv !== 0) {
				return (rv);
			}

			rv = p1.p_agent.localeCompare(p2.p_agent);
			if (rv !== 0) {
				return (rv);
			}

			return (p1.p_name.localeCompare(p2.p_agent));
		});

		probes.forEach(function (p) {
			fprintf(out, '    %s %-16s %s\n', p.p_agent,
			    args.vms[p.p_agent].tags.manta_role, p.p_name);
		});
		fprintf(out, '\n');
	}

	fprintf(out, 'SUMMARY\n');
	fprintf(out, '%6d wanted probe groups matched existing groups\n',
	    plan.mup_ngroupsmatch);
	fprintf(out, '%6d wanted probes matched existing probes\n',
	    plan.mup_nprobesmatch);
	fprintf(out, '%6d probe groups ignored (operator-added)\n',
	    plan.mup_ngroupsignore);
	fprintf(out, '%6d total probe groups to remove\n',
	    plan.mup_groups_remove.length);
	fprintf(out, '%6d total probes to remove\n',
	    plan.mup_probes_remove.length);
	fprintf(out, '%6d total probe groups to add\n',
	    plan.mup_groups_add.length);
	fprintf(out, '%6d total probes to add\n', plan.mup_probes_add.length);
	fprintf(out, '%6d warnings\n', plan.mup_warnings.length);

	plan.mup_warnings.forEach(function (w) {
		fprintf(out, 'warn: %s\n', w.message);
	});
}

/*
 * Apply the changes described by a MantaUpdatePlan.  This removes old probes
 * and probe groups and creates new ones to replace them.  This operation is not
 * atomic, and can wind up in basically any intermediate state.  However, the
 * broader operation (where we construct the update plan and then apply it) is
 * idempotent.  In the face of only transient errors, this process can be
 * re-applied to converge to the desired state.
 */
function amonUpdatePlanApply(args, callback)
{
	var plan, au;

	assertplus.object(args, 'args');
	assertplus.object(args.plan, 'args.plan');
	assertplus.object(args.amon, 'args.amon');
	assertplus.number(args.concurrency, 'args.concurrency');
	assertplus.string(args.account, 'args.account');

	plan = args.plan;
	au = new AmonUpdate(args);

	/*
	 * We always create probes inside probe groups.  In order to represent
	 * probes before we've created those probe groups, the "p_groupid"
	 * property for new probes identifies the name (not uuid) of the group
	 * they will be in.  (We assume that group names are unique, and this is
	 * validated elsewhere.)  When we create these probes shortly, we'll
	 * need to look up the real uuid of the group.  There are two cases:
	 * either the probe group already exists, in which case we have its uuid
	 * right now, or the probe group will be created by this process, in
	 * which case we'll need to record that and use it later.
	 *
	 * Here, we collect the names and uuids of probe groups that already
	 * exist and add them to mau_groups_byname.  As we create new probe
	 * groups, we'll add their names and uuids to the same structure.  We'll
	 * consult this when we go create new probes.
	 */
	jsprim.forEachKey(au.mau_plan.mup_deployed.mac_probegroups_by_name,
	    function forEachDeployedProbeGroup(name, group) {
		au.mau_groups_byname[name] = group.pg_uuid;
	    });

	/*
	 * Although Amon may tolerate probes whose groups are missing, we avoid
	 * creating such a state by processing each of these phases separately.
	 * Strictly speaking, we only need three phases to do this: remove old
	 * probes, remove and create probe groups, and create new probes.  It's
	 * simpler (and not much slower) to split this middle phase.
	 */
	vasync.pipeline({
	    'input': null,
	    'funcs': [
		function amonUpdateRemoveProbes(_, subcallback) {
			amonUpdateQueue(au, plan.mup_probes_remove,
			    amonUpdateProbeRemove, subcallback);
		},
		function amonUpdateRemoveProbeGroups(_, subcallback) {
			amonUpdateQueue(au, plan.mup_groups_remove,
			    amonUpdateGroupRemove, subcallback);
		},
		function amonUpdateAddProbeGroups(_, subcallback) {
			amonUpdateQueue(au, plan.mup_groups_add,
			    amonUpdateGroupAdd, subcallback);
		},
		function amonUpdateAddProbes(_, subcallback) {
			amonUpdateQueue(au, plan.mup_probes_add,
			    amonUpdateProbeAdd, subcallback);
		}
	    ]
	}, function (err) {
		callback(err);
	});
}

/*
 * Represents the state associated with a single amon update operation.
 * This class is used as a struct, with details private to this subsystem.
 */
function AmonUpdate(args)
{
	assertplus.object(args, 'args');
	assertplus.object(args.amon, 'args.amon');
	assertplus.object(args.plan, 'args.plan');
	assertplus.number(args.concurrency, 'args.concurrency');
	assertplus.string(args.account, 'args.account');

	this.mau_amon = args.amon;
	this.mau_concurrency = args.concurrency;
	this.mau_plan = args.plan;
	this.mau_account = args.account;
	this.mau_queues = [];
	this.mau_errors = [];
	this.mau_groups_byname = {};

	/* for debugging */
	this.mau_nprobes_removed = 0;
	this.mau_ngroups_removed = 0;
	this.mau_ngroups_added = 0;
	this.mau_nprobes_added = 0;
}

/*
 * Given a worker function, pushes all of the specified inputs through a queue.
 */
function amonUpdateQueue(au, tasks, worker, callback)
{
	var queue;

	queue = vasync.queuev({
	    'concurrency': au.mau_concurrency,
	    'worker': function queueWorker(task, qcallback) {
		worker(au, task, function onWorkDone(err) {
			if (err) {
				au.mau_errors.push(err);
			}

			qcallback();
		});
	    }
	});

	au.mau_queues.push(queue);

	tasks.forEach(function (t) {
		queue.push(t);
	});

	queue.on('end', function () {
		/* XXX commonize */
		if (au.mau_errors.length === 0) {
			callback();
		} else if (au.mau_errors.length == 1) {
			callback(au.mau_errors[0]);
		} else {
			callback(new MultiError(au.mau_errors));
		}
	});
	queue.close();
}

function amonUpdateProbeAdd(au, probe, callback)
{
	var newprobe;

	assertplus.strictEqual(probe.p_uuid, null);
	newprobe = {
	    'name': probe.p_name,
	    'type': probe.p_type,
	    'config': probe.p_config,
	    'agent': probe.p_agent,
	    'machine': probe.p_machine || undefined,
	    'contacts': probe.p_contacts,
	    'groupEvents': probe.p_group_events
	};

	/*
	 * By this point in the process, we must have a name -> uuid mapping for
	 * the group associated with this probe.
	 */
	assertplus.ok(au.mau_groups_byname.hasOwnProperty(probe.p_groupid));
	newprobe.group = au.mau_groups_byname[probe.p_groupid];

	au.mau_amon.createProbe(au.mau_account, newprobe,
	    function onAmonProbeAdd(err) {
		if (err) {
			err = new VError(err, 'add probe "%s"', probe.p_name);
		} else {
			au.mau_nprobes_added++;
		}

		callback(err);
	    });
}

function amonUpdateProbeRemove(au, probe, callback)
{
	assertplus.string(probe.p_uuid);
	au.mau_amon.deleteProbe(au.mau_account, probe.p_uuid,
	    function onAmonProbeRemove(err) {
		if (err) {
			err = new VError(err, 'remove probe "%s"',
			    probe.p_uuid);
		} else {
			au.mau_nprobes_removed++;
		}

		callback(err);
	    });
}

function amonUpdateGroupAdd(au, group, callback)
{
	var newgroup;

	/*
	 * Prior to this point, the uuid matches the name.
	 */
	assertplus.strictEqual(group.pg_uuid, group.pg_name);
	newgroup = {
	    'name': group.pg_name,
	    'user': group.pg_user,
	    'contacts': group.pg_contacts
	};

	assertplus.ok(!au.mau_groups_byname.hasOwnProperty(group.pg_name));
	au.mau_amon.createProbeGroup(au.mau_account, newgroup,
	    function onAmonGroupAdd(err, amongroup) {
		if (!err && typeof (amongroup.uuid) != 'string') {
			err = new VError('amon returned group with bad or ' +
			    'missing uuid');
		}

		if (!err && amongroup.name != group.pg_name) {
			err = new VError('amon returned group with a ' +
			    'different name (uuid "%s")', amongroup.uuid);
		}

		if (err) {
			err = new VError(err, 'add group "%s"', group.pg_uuid);
			callback(err);
			return;
		} else {
			au.mau_ngroups_added++;
		}

		assertplus.ok(!au.mau_groups_byname.hasOwnProperty(
		    group.pg_name));
		au.mau_groups_byname[group.pg_name] = amongroup.uuid;
		callback(err);
	    });
}

function amonUpdateGroupRemove(au, group, callback)
{
	assertplus.string(group.pg_uuid);
	au.mau_amon.deleteProbeGroup(au.mau_account, group.pg_uuid,
	    function onAmonGroupRemove(err) {
		if (err) {
			err = new VError(err, 'remove group "%s"',
			    group.pg_uuid);
		} else {
			au.mau_ngroups_removed++;
		}

		callback(err);
	    });
}
