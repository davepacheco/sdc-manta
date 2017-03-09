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
 */

var assertplus = require('assert-plus');
var jsprim = require('jsprim');
var progbar = require('progbar');
var vasync = require('vasync');
var VError = require('verror');
var MultiError = VError.MultiError;

/* Exported interface */
exports.amonLoadProbeGroups = amonLoadProbeGroups;
exports.amonLoadComponentProbes = amonLoadComponentProbes;
exports.MantaAmonConfig = MantaAmonConfig;

/*
 * Fetches Amon probe groups.
 *
 *     amon             a restify JSON client for the AMON master API
 *
 *     account		Triton account uuid whose probes to fetch
 *
 * callback is invoked as "callback(err, amonconfig)", where on success
 * "amonconfig" is an instance of MantaAmonConfig.
 */
function amonLoadProbeGroups(args, callback)
{
	var account, amon;

	assertplus.object(args, 'args');
	assertplus.object(args.amon, 'args.amon');
	assertplus.func(callback, 'callback');

	account = args.account;
	amon = args.amon;
	amon.listProbeGroups(account, function (err, rawgroups) {
		var amoncfg;

		if (err) {
			err = new VError(err, 'listing probegroups');
			callback(err);
			return;
		}

		amoncfg = new MantaAmonConfig();
		rawgroups.forEach(function (rawgroup) {
			/* XXX validate schema */
			/* XXX validate no duplicate names */
			amoncfg.addProbeGroup(rawgroup);
		});

		callback(null, amoncfg);
	});
}

/*
 * Fetches Amon probe objects for all probes for the specified components.
 * Named arguments:
 *
 *     amon             a restify JSON client for the AMON master API.
 *     			This is different from most other consumers, which use
 *     			an actual Amon client.
 *
 *     amoncfg          an instance of MantaAmonConfig with probe groups
 *                      configured already.  This configuration will be updated
 *                      with probe details.
 *
 *     components	an array of objects describing the components.  Each
 *     			component should have properties:
 *
 *     		"type"	either "cn" (for compute nodes) or "vm" (for containers)
 *
 *     		"uuid"  the server_uuid (for type "cn") or VM uuid (for
 *     			containers)
 *
 *     concurrency	an integer number for the maximum concurrent requests
 *
 * "callback" is invoked as "callback(err)".
 *
 * Amon has an API for listing probes, but it's limited to 1000 probes, which is
 * too small for large Manta deployments.  Additionally, that API has no support
 * for pagination.  Instead, we use the private Amon agent API to fetch the list
 * of probes for each agent.  That number is generally much smaller.  This
 * results in a lot more requests, but we don't have a better option.
 */
function amonLoadComponentProbes(args, callback)
{
	var amoncfg, client, queue, errors, progress, ndone;

	assertplus.object(args, 'args');
	assertplus.object(args.amon, 'args.amon');
	assertplus.object(args.amoncfg, 'args.amoncfg');
	assertplus.ok(args.amoncfg instanceof MantaAmonConfig);
	assertplus.number(args.concurrency, 'args.concurrency');
	assertplus.arrayOfObject(args.components, 'args.components');
	assertplus.func(callback, 'callback');

	amoncfg = args.amoncfg;
	client = args.amon;
	errors = [];
	ndone = 0;
	if (process.stderr.isTTY) {
		progress = new progbar.ProgressBar({
		    'filename': 'fetching probes for each agent',
		    'bytes': false,
		    'size': args.components.length
		});
	}

	queue = vasync.queuev({
	    'concurrency': args.concurrency,
	    'worker': function fetchProbeQueueWorker(component, qcallback) {
		assertplus.object(component, 'component');
		assertplus.string(component.type, 'component.type');
		assertplus.string(component.uuid, 'component.uuid');

		amonFetchAgentProbes({
		    'amon': client,
		    'agentUuid': component.uuid
		}, function (err, probes) {
			if (err) {
				err = new VError(err, 'fetching probes for ' +
				    'agent on %s "%s"', component.type,
				    component.uuid);
				errors.push(err);
				return;
			}

			/* XXX validate */
			probes.forEach(function (p) {
				amoncfg.addProbe(p);
			});

			ndone++;
			if (progress !== undefined) {
				progress.advance(ndone);
			}

			qcallback();
		});
	    }
	});

	args.components.forEach(function (c, i) {
		var label = 'args.components[' + i + ']';
		assertplus.string(c.type, label + '.type');
		assertplus.string(c.uuid, label + '.uuid');
		queue.push({ 'type': c.type, 'uuid': c.uuid });
	});

	queue.on('end', function () {
		if (progress !== undefined) {
			progress.end();
		}

		/* XXX commonize */
		if (errors.length > 1) {
			callback(new MultiError(errors));
		} else if (errors.length == 1) {
			callback(errors[0]);
		} else {
			callback(null);
		}
	});

	queue.close();
}

/*
 * Uses the amon (private) relay API to list the probes associated with the
 * given agent.
 *
 * Named arguments:
 *
 *     amon             a restify JSON client for the AMON master API
 *
 *     agentUuid        uuid of the agent whose probes should be fetched
 */
function amonFetchAgentProbes(args, callback)
{
	var client, uripath;

	assertplus.object(args, 'args');
	assertplus.object(args.amon, 'args.amon');
	assertplus.string(args.agentUuid, 'args.agentUuid');
	assertplus.func(callback, 'callback');

	client = args.amon;
	uripath = '/agentprobes?agent=' + encodeURIComponent(args.agentUuid);
	client.get(uripath, function (err, req, res, result) {
		if (err) {
			err = new VError(err, 'amon: get "%s"', uripath);
			callback(err);
			return;
		}

		/* XXX fail if we get back exactly 1000 results? */
		callback(null, result);
	});
}

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

	probe = new AmonProbe(probedef);

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

	probegroup = new AmonProbeGroup(groupdef);

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
 * Classes used as simple structs
 */

/*
 * This class is used as a struct, with details private to this subsystem.
 * The fields here mirror those in the Amon API for Probes.  Because this can
 * represent probes that have not yet been created, the uuid is not required.
 * Optional fields are "null" when not present.
 */
function AmonProbe(probedef)
{
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

	this.p_uuid = probedef.uuid || null;
	this.p_name = probedef.name;
	this.p_type = probedef.type;
	this.p_config = jsprim.deepCopy(probedef.config);
	this.p_agent = probedef.agent;
	this.p_machine = probedef.machine || null;
	this.p_groupid = probedef.group || null;
	this.p_contacts = probedef.contacts || null;
	this.p_group_events = probedef.groupEvents || false;
}

/*
 * This class is used as a struct, with details private to this subsystem.
 * The fields here mirror those in the Amon API for Probe Groups.  Because this
 * can represent probes that have not yet been created, the uuid is not
 * required.  Optional fields are "null" when not present.
 */
function AmonProbeGroup(groupdef)
{
	assertplus.object(groupdef, 'groupdef');
	assertplus.string(groupdef.user, 'groupdef.user');
	assertplus.string(groupdef.uuid, 'groupdef.uuid');
	assertplus.string(groupdef.name, 'groupdef.name');
	assertplus.arrayOfString(groupdef.contacts, 'groupdef.contacts');

	this.pg_name = groupdef.name;
	this.pg_user = groupdef.user;
	this.pg_uuid = groupdef.uuid;
	this.pg_contacts = groupdef.contacts.slice(0);
}
