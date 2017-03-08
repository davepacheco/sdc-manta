/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * lib/alarms/amon_config.js: facilities for representing a set of amon
 * configuration, which essentially means a set of probes and probe groups.
 *
 * There are three sources of information related to probes and alarms:
 *
 *    (1) The list of instances of each component that are deployed.  This
 *        includes the list of VMs and CNs.
 *
 *    (2) Local configuration files describe the set of probes and probe groups
 *        that should exist for a Manta deployment.  These descriptions are
 *        templates that are stamped out for each instance of various
 *        components.  To compare this with what's actually deployed, this
 *        information needs to be joined with information about which instances
 *        of which services are currently deployed.
 *
 *        This local configuration also includes knowledge articles, which
 *        provide additional information for the operator associated with each
 *        probe group (like instructions about how to respond to various types
 *        of alarms).
 *
 *    (3) Amon is the canonical store for the set of probes and probe groups
 *        that are configured, as well what alarms are open and the faults
 *        associated with each alarm.  Amon only knows about its own agents,
 *        which have uuids corresponding to VM and CN uuids.  To make sense of
 *        this information, it has to be at least joined with the list of
 *        components deployed, but likely also the local metadata associated
 *        with probe groups.
 *
 *        This source can be split further into the list of alarms and probe
 *        groups and (separately) the list of probes.  The list of probes is
 *        much more expensive to gather.
 *
 * Using this information, we want to support a few different stories:
 *
 *    (1) List open alarms or detailed information about specific alarms.
 *        ("manta-adm alarm show" and "manta-adm alarm list")
 *
 *        We want to present the list of known, active problems.  This is the
 *        list of open alarms, which we can fetch from Amon.  We want to
 *        associate each problem with the affected components using their
 *        service names.  That requires joining the "machine" that's provided
 *        in each fault with the information we fetched separately about
 *        deployed VMs and CNs.  We also want to provide knowledge article
 *        content about each alarm by joining with the local configuration,
 *        based on the alarm's probe group name.
 *
 *    (2) List configured probes and probe groups.
 *        ("manta-adm amon config show", "manta-adm amon config probegroups",
 *        and "manta-adm amon config probes")
 *
 *        It's useful for operators to see what probes have been configured.
 *        This involves fetching probes and probe groups from Amon and combining
 *        that information with the local knowledge articles for each one and
 *        possibly the list of VMs and CNs deployed.
 *
 *    (3) Update the probe and probe group configuration.
 *        ("manta-adm amon config verify", "manta-adm amon config update")
 *
 *        For both initial deployment and subsequent updates, it's important to
 *        have an idempotent operation that compares what probes and probe
 *        groups are supposed to be configured with what's actually deployed and
 *        then updates the deployment to match what's expected.  This also
 *        involves joining all three sources of information.
 *
 * Adding to the complexity, there are several other types of probes or probe
 * groups that we may encounter:
 *
 *     - Probes and probe groups added by operators for their own custom
 *       monitoring.  This is fully supported, though it cannot be configured
 *       using the Manta tools.  We present these as best we can -- using
 *       whatever metadata is in the probe groups rather than knowledge article
 *       information.
 *
 *     - Probes and probe groups added by previous versions of this software
 *       before any of the local metadata was provided.  These groups are
 *       explicitly deprecated: we want operators to move away from them because
 *       they're very hard to use.  We treat these mostly like probes and probe
 *       groups that operators added, except that we also warn operators that
 *       they should be removed, and we'll treat them as removable when using
 *       "manta-adm amon config verify/update".
 *
 *     - Other probes and probe groups added by other versions of this software
 *       (either older or newer) that had local metadata at the time.  We can
 *       distinguish these because of the way probe groups are named.  We treat
 *       these similar to probes and probe groups that were added before this
 *       metadata was available: we'll consider them removable during "manta-adm
 *       alarm config verify/update".
 *
 * To enable all this, we provide a few abstractions:
 *
 *    - The MantaAmonMetadata class represents the local information about the
 *      probe groups and probes that we know about.  This includes knowledge
 *      articles for probe groups that we support today as well as the knowledge
 *      about which probe groups were added by previous versions of the
 *      software.
 *
 *    - The MantaAmonConfig class represents a set of probes and probe groups.
 *      There are two ways of initializing this class: either from a set of
 *      probes and probe groups loaded from Amon (in which case this represents
 *      the deployed configuration) or by generating a set automatically from
 *      the local configuration (in which case this represents the desired
 *      configuration).  In both cases, VM and CN metadata is also part of the
 *      representation.  Instances of these class can be diff'd to determine how
 *      to move from one deployed configuration to another.
 *
 *    - The MantaAmonAlarms class represents a set of alarms fetched from Amon.
 *      Callers use this together with the other two classes to print
 *      information about active problems.
 *
 * XXX
 *     MantaAmonAlarms
 *     - eachAlarm(func)
 *     - In the future, this could have filters by zone service, CN, etc.
 */

var assertplus = require('assert-plus');
var jsprim = require('jsprim');
var VError = require('verror');

var fprintf = require('extsprintf').fprintf;
var services = require('../services');

/* Exported interface */
exports.MantaAmonConfig = MantaAmonConfig;
exports.MantaAmonMetadata = MantaAmonMetadata;
exports.amonUpdatePlanCreate = amonUpdatePlanCreate;
exports.amonUpdatePlanSummarize = amonUpdatePlanSummarize;

/*
 * List of unversioned probe group names used by previous versions of this
 * software.
 */
var MAM_LEGACY_PROBEGROUP_NAMES = [
    'authcache-alert',
    'compute-alert',
    'electric-moray-alert',
    'jobsupervisor-alert',
    'loadbalancer-alert',
    'moray-alert',
    'nameservice-alert',
    'ops-alert',
    'ops-info',
    'postgres-alert',
    'storage-alert',
    'webapi-alert'
];


/*
 * Probe group names
 *
 * Probe templates are defined in the source code configuration.  Each template
 * is expected to correspond to a distinct failure mode.  There may be more than
 * one probe group for each template, depending on the scope.  These probe
 * groups need to have names, and those names link them to the metadata we have
 * (i.e., the knowledge articles).  To do this, we use FMA-style event names
 * (e.g., upset.manta.$service.$problem).  Since this information will be
 * programmatically parsed, we want to include a version number.  Together, we
 * construct the probe group name for a given template by taking the FMA-style
 * event name, substituting the service name if requested, and appending a
 * version suffix.
 *
 * Given an arbitrary probe group name, we can classify it into one of a few
 * buckets:
 *
 *    - If it matches one of the well-known probe groups used by previous
 *      versions of this software, we call that "legacy".  We don't have
 *      metadata about these groups, and they should be removed if we're making
 *      updates to the probe configuration.
 *
 *    - Otherwise, if we cannot find the ";v=" suffix, then we assume this not a
 *      probe created by this software.  This is likely something operators
 *      created.  We'll generally leave these alone.
 *
 *    - Otherwise, if we find the suffix, but the version is newer than one we
 *      recognize, then we'll not touch this probe group.  In the future, if we
 *      decide to change the encoding (e.g., to include additional information
 *      in the probe group name), then we can do so as long as we preserve a
 *      ";v=" suffix with a new version number.
 *
 *    - Finally, if we find an acceptable version suffix, then this is a probe
 *      group that we know how to manage.
 *
 * See the block comment at the top of this file for details on these different
 * kinds of probe groups.
 */

function probeGroupNameForTemplate(pt, eventname)
{
	assertplus.object(pt, 'pt');
	assertplus.string(eventname, 'eventname');
	return (eventname + ';v=1');
}

function parseProbeGroupName(probeGroupName)
{
	var result, i, verpart;

	result = {};
	result.error = null;		/* failure to parse (bad version) */
	result.isLegacy = null;		/* from "mantamon" era */
	result.isOther = null;		/* operator-created */
	result.eventName = null;	/* software-created, versioned era */

	if (MAM_LEGACY_PROBEGROUP_NAMES.indexOf(probeGroupName) != -1) {
		result.isLegacy = true;
		return (result);
	}

	i = probeGroupName.indexOf(';');
	if (i == -1 || probeGroupName.substr(i + 1, 2) != 'v=') {
		result.isOther = true;
		return (result);
	}

	verpart = probeGroupName.substr(i + 3);
	if (verpart != '1') {
		result.error = new VError('unrecognized version "%s" in ' +
		    'probe group with name "%s"', verpart, probeGroupName);
		return (result);
	}

	result.eventName = probeGroupName.slice(0, i);
	return (result);
}


/*
 * Local metadata
 *
 * An instance of MantaAmonMetadata represents the local metadata associated
 * with probes and probe groups.
 */

function MantaAmonMetadata()
{
	/* Probe group information keyed by the configured event name. */
	this.mam_templates_byevent = {};

	/*
	 * A single template can be used to define multiple probe groups with
	 * the service name filled into the event name, which makes it different
	 * for each service.  For example, the "SMF maintenance" template
	 * has a scope of "each", which causes us to create one probe group per
	 * distinct service.  The event name in the template is:
	 *
	 *     upset.manta.$service.smf_maintenance
	 *
	 * This creates one event per distinct service, which look like:
	 *
	 *     upset.manta.postgres.smf_maintenance
	 *     upset.manta.moray.smf_maintenance
	 *     ...
	 *
	 * To be able to recognize these expanded names, we expand them as we
	 * process each template and store aliases here.
	 */
	this.mam_event_aliases = {};
}

/*
 * Loads a probe template into this data structure.  This would normally come
 * from the probe template files checked into this repository, though the test
 * suite can use this to load specific templates.
 */
MantaAmonMetadata.prototype.addTemplate = function addTemplate(args)
{
	var inp, eventName, pt, error, nsubs;
	var self = this;

	assertplus.object(args, 'args');
	assertplus.object(args.input, 'args.input');
	assertplus.string(args.originLabel, 'args.originLabel');

	/* XXX validate against JSON schema */
	inp = args.input;
	eventName = inp.event;

	if (this.mam_templates_byevent.hasOwnProperty(eventName)) {
		return (new VError('template "%s" re-uses event name "%s" ' +
		    'previously used in template "%s"', args.originLabel,
		    eventName,
		    this.mam_templates_byevent[eventName].pt_origin_label));
	}

	pt = new ProbeTemplate({
	    'input': inp,
	    'originLabel': args.originLabel
	});

	this.mam_templates_byevent[eventName] = pt;

	if (pt.pt_scope.ptsc_service != 'each') {
		return (null);
	}

	/*
	 * Generate per-service aliases for probe groups that generate more than
	 * one event name.
	 */
	nsubs = 0;
	services.mSvcNames.forEach(function (svcname) {
		/*
		 * XXX make this a different list of services?
		 * Or create a predicate for this?
		 */
		if (svcname == 'marlin')
			return;

		/* XXX check this against JavaScript identifier definition */
		var aliasname = pt.pt_event.replace(
		    /\$([a-zA-Z_][a-zA-Z0-9_]*)/g,
		    function onMatch(substr, varname) {
			assertplus.equal('$' + varname, substr);
			if (varname == 'service') {
				return (svcname);
			}

			if (error !== null) {
				error = new VError('template "%s": unknown ' +
				    'variable "%s" in event name',
				    pt.pt_origin_label, substr);
			}

			nsubs++;
			return ('INVALID');
		    });
		pt.pt_aliases.push({
		    'pta_event': aliasname,
		    'pta_service': svcname
		});
	});

	if (error === null && nsubs === 0) {
		return (new VError('template "%s": templates with scope ' +
		    '"each" must use "$service" in event name to ensure ' +
		    'uniqueness', pt.pt_origin_label));
	}

	if (error !== null) {
		return (error);
	}

	pt.pt_aliases.forEach(function (alias) {
		assertplus.ok(!self.mam_event_aliases.hasOwnProperty(alias));
		self.mam_event_aliases[alias] = pt.pt_event;
	});

	return (null);
};

MantaAmonMetadata.prototype.resolveEventName = function (eventName)
{
	if (this.mam_event_aliases.hasOwnProperty(eventName)) {
		assertplus.ok(this.mam_templates_byevent.hasOwnProperty(
		    this.mam_event_aliases[eventName]));
		return (this.mam_event_aliases[eventName]);
	}

	if (this.mam_templates_byevent.hasOwnProperty(eventName)) {
		return (eventName);
	}

	return (null);
};

/*
 * Iterate all registered templates.
 */
MantaAmonMetadata.prototype.eachTemplate = function (func)
{
	jsprim.forEachKey(this.mam_templates_byevent, function (_, pt) {
		func(pt);
	});
};

/*
 * Given an event called "eventName", return the appropriate knowledge article
 * for it.  Returns null if there is no knowledge article registered for this
 * event.
 */
MantaAmonMetadata.prototype.eventKa = function eventKa(eventName)
{
	var resolved = this.resolveEventName(eventName);
	if (resolved === null) {
		return (null);
	}

	return (this.mam_templates_byevent[eventName].pt_ka);
};

/*
 * Given a probe group with name "probeGroupName", determine whether it should
 * be removed as part of a configuration update operation.  See the block
 * comment at the top of this file for an explanation of why we mark different
 * types of groups for removal.
 */
MantaAmonMetadata.prototype.probeGroupIsRemovable =
    function probeGroupIsRemovable(probeGroupName)
{
	var result, eventName;

	result = parseProbeGroupName(probeGroupName);
	if (result.error !== null || result.isOther) {
		return (false);
	}

	if (result.isLegacy) {
		return (true);
	}

	assertplus.string(result.eventName);
	eventName = this.resolveEventName(result.eventName);
	return (eventName !== null);
};

/*
 * Given a probe group with name "probeGroupName", return the string name of the
 * event that is emitted when an alarm for this group fires.  This is primarily
 * useful for passing to the eventKa() function to get the knowledge article
 * associated with this probe group.  This function returns null if the event
 * name is unknown or not applicable (because it's an operator-created probe
 * group or the like).
 */
MantaAmonMetadata.prototype.probegroupEventName =
    function probeGroupEventName(probeGroupName)
{
	var result;

	result = parseProbeGroupName(probeGroupName);
	if (result.error !== null || result.isLegacy || result.isOther) {
		return (null);
	}

	assertplus.string(result.eventName);
	return (result.eventName);
};


/*
 * Amon configuration
 *
 * The MantaAmonConfig class represents a set of probes and probe groups.  See
 * the block comment at the top of this file for details.
 *
 * This implementation requires that probe group names be unique.  That's
 * because the only way to compare what we expect to be deployed against what's
 * really deployed is based on the probe group names.  If we have more than one
 * probe group with the same name, then it would be much harder to tell whether
 * the right probes were deployed.
 *
 * XXX We need to square away the validation story for this.  I think what we
 * probably want to do is have the addProbe()/addProbeGroup() functions return
 * an error when they fail (e.g., when we get a duplicate probe group name), and
 * the callers actually need to handle that.
 * XXX Consumers also need to know to add probe groups before probes.
 */

function MantaAmonConfig()
{
	/*
	 * mapping of probe group name -> probe group object
	 * This is the canonical set of probe groups represented by this object.
	 */
	this.mac_probegroups_by_name = {};

	/*
	 * mapping of probe group uuid -> probe group name
	 * This set is updated as callers add probe groups, but it's only used
	 * as callers subsequently add probes in order to map those probes to
	 * corresponding probe groups.
	 */
	this.mac_probegroups_by_uuid = {};

	/*
	 * mapping of probe group name -> list of probes
	 * Along with mac_probes_orphan below, this is the canonical set of
	 * probes represented by this object.
	 */
	this.mac_probes_by_probegroup = {};

	/* List of probes having no group */
	this.mac_probes_orphan = [];
}

/*
 * Adds a probe.  The "probedef" object must match the Amon schema for a probe.
 */
MantaAmonConfig.prototype.addProbe = function (probedef)
{
	var probe, pgname;

	assertplus.object(probedef, 'probedef');
	assertplus.optionalString(probedef.uuid, 'probedef.uuid');
	assertplus.string(probedef.name, 'probedef.name');
	assertplus.string(probedef.type, 'probedef.type');
	assertplus.object(probedef.config, 'probedef.config');
	assertplus.string(probedef.agent, 'probedef.agent');
	assertplus.optionalString(probedef.machine, 'probedef.machine');
	assertplus.optionalString(probedef.group, 'probedef.group');
	assertplus.optionalArrayOfString(probedef.contacts,
	    'probedef.contacts');
	assertplus.optionalBool(probedef.groupEvents, 'probedef.groupEvents');

	/* XXX define a constructor */
	probe = {};
	probe.p_uuid = probedef.uuid || null;
	probe.p_name = probedef.name;
	probe.p_type = probedef.type;
	probe.p_config = jsprim.deepCopy(probedef.config);
	probe.p_agent = probedef.agent;
	probe.p_machine = probedef.machine || null;
	probe.p_groupid = probedef.group || null;
	probe.p_contacts = probedef.contacts || null;
	probe.p_group_events = probedef.groupEvents || false;

	if (probe.p_groupid === null) {
		this.mac_probes_orphan.push(probe);
		return;
	}

	if (!this.mac_probegroups_by_uuid.hasOwnProperty(probe.p_groupid)) {
		throw (new VError('probe "%s": unknown probe group "%s"',
		    probe.p_uuid, probe.p_groupid));
	}

	pgname = this.mac_probegroups_by_uuid[probe.p_groupid];
	assertplus.ok(this.mac_probes_by_probegroup.hasOwnProperty(pgname));
	this.mac_probes_by_probegroup[pgname].push(probe);
};

/*
 * Adds a probe group.  The "groupdef" object must match the Amon schema for a
 * probe group.
 */
MantaAmonConfig.prototype.addProbeGroup = function (groupdef)
{
	var probegroup;

	assertplus.object(groupdef, 'groupdef');
	assertplus.string(groupdef.user, 'groupdef.user');
	assertplus.string(groupdef.uuid, 'groupdef.uuid');
	assertplus.string(groupdef.name, 'groupdef.name');
	assertplus.arrayOfString(groupdef.contacts, 'groupdef.contacts');

	/* XXX define a constructor */
	probegroup = {};
	probegroup.pg_name = groupdef.name;
	probegroup.pg_user = groupdef.user;
	probegroup.pg_uuid = groupdef.uuid;
	probegroup.pg_contacts = groupdef.contacts.slice(0);

	/* XXX see above -- needs to be an operational error */
	assertplus.ok(!this.mac_probegroups_by_name.hasOwnProperty(
	    probegroup.pg_name),
	    'duplicate probe group name: "' + probegroup.pg_name + '"');
	this.mac_probegroups_by_name[probegroup.pg_name] = probegroup;

	assertplus.ok(!this.mac_probegroups_by_uuid.hasOwnProperty(
	    probegroup.pg_uuid),
	    'duplicate probe group id: ' + probegroup.pg_uuid);
	this.mac_probegroups_by_uuid[probegroup.pg_uuid] = probegroup.pg_name;

	assertplus.ok(!this.mac_probes_by_probegroup.hasOwnProperty(
	    probegroup.pg_name));
	this.mac_probes_by_probegroup[probegroup.pg_name] = [];
};

/*
 * Returns the specified probe group, if it exists.  Otherwise, returns null.
 */
MantaAmonConfig.prototype.probeGroupForName = function (pgname)
{
	assertplus.string(pgname, 'pgname');
	if (!this.mac_probegroups_by_name.hasOwnProperty(pgname)) {
		return (null);
	}

	return (this.mac_probegroups_by_name[pgname]);
};

MantaAmonConfig.prototype.hasProbeGroup = function (pgname)
{
	assertplus.string(pgname);
	return (this.mac_probes_by_probegroup.hasOwnProperty(pgname));
};

/*
 * Iterates all of the probe groups in this configuration and invokes
 * "func(probegroup)".
 */
MantaAmonConfig.prototype.eachProbeGroup = function (func)
{
	var probesbypg;

	assertplus.func(func, 'func');
	probesbypg = this.mac_probes_by_probegroup;
	jsprim.forEachKey(this.mac_probegroups_by_name, function (name, pg) {
		assertplus.ok(probesbypg.hasOwnProperty(name));
		func(pg);
	});
};

/*
 * Iterates all probes in this configuration that are associated with probe
 * group "pgname" and invokes "func(probe)" for each one.
 */
MantaAmonConfig.prototype.eachProbeGroupProbe = function (pgname, func)
{
	var probes;
	assertplus.string(pgname, 'pgname');
	assertplus.func(func, 'func');
	assertplus.ok(this.mac_probes_by_probegroup.hasOwnProperty(pgname),
	    'unknown probe group name: "' + pgname + '"');
	probes = this.mac_probes_by_probegroup[pgname];
	probes.forEach(function (p) { func(p); });
};

/*
 * Iterates all probes in this configuration that have no associated probe
 * group and invokes "func(probe)" for each one.
 */
MantaAmonConfig.prototype.eachOrphanProbe = function (func)
{
	assertplus.func(func, 'func');
	this.mac_probes_orphan.forEach(function (p) { func(p); });
};


/*
 * Amon update plan
 *
 * The MantaAmonUpdatePlan class represents a set of probes and probe groups to
 * be removed and a set of probes and probe groups to be added in order to
 * update the Amon configuration for the Manta service.  See the block comment
 * at the top of this file for details.
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
 *     vms	object mapping VMAPI vm uuids to VMAPI VM objects for all
 *     		active VMs in this deployment
 *
 *     cns	object mapping CNAPI server uuids to CNAPI server objects for
 *     		all CNs hosting the VMs in "vms"
 *
 *     sapi_instances	object mapping SAPI instance uuids to SAPI objects for
 *     			all VMs in "vms"
 *
 *     account  Triton account uuid to use for wanted Amon probes
 *
 *     contacts	Array of Amon contact methods (strings) to use
 *
 *     deployed	MantaAmonConfig object describing the set of probes and probe
 *     		groups curently deployed
 *
 *     metadata	MantaAmonMetadata object describing the set of probes and probe
 *     		groups that should be deployed
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
	assertplus.ok(args.deployed instanceof MantaAmonConfig);
	assertplus.object(args.metadata, 'args.metadata');
	assertplus.ok(args.metadata instanceof MantaAmonMetadata);

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
			    !jsprim.deepEqual(dp.p_contacts.slice(0).sort(),
			    wp.p_contacts.slice(0).sort())) {
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
	assertplus.ok(args.metadata instanceof MantaAmonMetadata);

	contacts = args.contacts.slice(0);
	wanted = new MantaAmonConfig();

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
	assertplus.ok(args.wanted instanceof MantaAmonConfig);
	assertplus.object(args.probeTemplate, 'args.probeTemplate');
	assertplus.ok(args.probeTemplate instanceof ProbeTemplate);
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
		var pgname = probeGroupNameForTemplate(pt, eventName);
		/*
		 * XXX it's a little dicey to fake up the probe group uuid like
		 * this.
		 */
		wanted.addProbeGroup({
		    'uuid': pgname,
		    'name': pgname,
		    'user': args.account,
		    'contacts': args.contacts
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
					probes.push({
					    'agent': c,
					    'machine': t
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
				    'group': probeGroupNameForTemplate(
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
	assertplus.ok(args.metadata instanceof MantaAmonMetadata);
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
			evt = metadata.probegroupEventName(pg.pg_name);
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
 * This class is used as a struct, with details private to this subsystem.
 * The fields here closely mirror those in the probe template schema.  For
 * details, see the documentation for that.
 *
 * The constructor takes arguments in the form as it comes out of the the
 * YAML-parsed files.  These structures should have already been validated.
 */
function ProbeTemplate(args)
{
	var self = this;
	var inp;

	assertplus.object(args, 'args');
	assertplus.object(args.input, 'args.input');
	assertplus.string(args.originLabel, 'args.originLabel');

	inp = args.input;

	/*
	 * The origin label is a string describing the source of this template.
	 * It's generally a filename and potentially an index into the templates
	 * listed in the file.  This is used in error messages that result from
	 * building a configuration based on this template.
	 */
	this.pt_origin_label = args.originLabel;

	/* FMA-style event class for this probe template. */
	this.pt_event = inp.event;

	/*
	 * The scope object describes which components this probe monitors (and
	 * potentially from which other components, if those are different).
	 */
	this.pt_scope = {};
	this.pt_scope.ptsc_service = inp.scope.service;
	this.pt_scope.ptsc_global = (inp.scope.global === true);
	this.pt_scope.ptsc_check_from = inp.scope.checkFrom || null;

	this.pt_checks = [];
	inp.checks.forEach(function (c) {
		var cc;

		cc = {};
		cc.ptc_type = c.type;
		cc.ptc_config = jsprim.deepCopy(c.config);
		self.pt_checks.push(cc);
	});

	this.pt_ka = {};
	this.pt_ka.ka_title = inp.ka.title;
	this.pt_ka.ka_description = inp.ka.description;
	this.pt_ka.ka_severity = inp.ka.severity;
	this.pt_ka.ka_response = inp.ka.response;
	this.pt_ka.ka_impact = inp.ka.impact;
	this.pt_ka.ka_action = inp.ka.action;
	this.pt_aliases = [];
}
