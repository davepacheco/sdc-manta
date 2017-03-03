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
 */

var assertplus = require('assert-plus');
var jsprim = require('jsprim');

/* Exported interface */
module.exports = AmonConfig;

/*
 * Represents an Amon configuration, which is a set of probes and probe groups.
 * This implementation assumes that every probe is part of a probe group,
 * that contacts are only specified at the group level, and that "groupEvents"
 * is always true.
 */
function AmonConfig()
{
	this.ac_probes = [];
	this.ac_probegroups = [];
}

AmonConfig.prototype.addProbe = function (probedef)
{
	assertplus.object(probedef, 'probedef');
	assertplus.string(probedef.name, 'probedef.name');
	assertplus.string(probedef.type, 'probedef.type');
	assertplus.object(probedef.config, 'probedef.config');
	assertplus.string(probedef.agent, 'probedef.agent');
	assertplus.optionalString(probedef.machine, 'probedef.machine');
	assertplus.string(probedef.group, 'probedef.group');

	this.ac_probes.push({
	    'name': probedef.name,
	    'type': probedef.type,
	    'config': jsprim.deepCopy(probedef.config),
	    'agent': probedef.agent,
	    'machine': probedef.machine,
	    'group': probedef.group,
	    'groupEvents': true
	});
};

AmonConfig.prototype.addProbeGroup = function (groupdef)
{
	assertplus.object(groupdef, 'groupdef');
	assertplus.string(groupdef.user, 'groupdef.user');
	assertplus.string(groupdef.uuid, 'groupdef.uuid');
	assertplus.string(groupdef.name, 'groupdef.name');
	assertplus.arrayOfString(groupdef.contacts, 'groupdef.contacts');

	this.ac_probegroups.push({
	    'name': groupdef.name,
	    'user': groupdef.user,
	    'uuid': groupdef.uuid,
	    'contacts': groupdef.contacts.slice(0),
	});
};
