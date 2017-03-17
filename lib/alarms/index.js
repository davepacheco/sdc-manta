/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * lib/alarms/index.js: facilities for working with Amon probes, probe groups,
 * alarms, and the local metadata used to configure and augment these objects.
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
 *        ("manta-adm alarm config show", "manta-adm alarm config probegroups",
 *        and "manta-adm alarm config probes")
 *
 *        It's useful for operators to see what probes have been configured.
 *        This involves fetching probes and probe groups from Amon and combining
 *        that information with the local knowledge articles for each one and
 *        possibly the list of VMs and CNs deployed.
 *
 *    (3) Update the probe and probe group configuration.
 *        ("manta-adm alarm config verify", "manta-adm alarm config update")
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
 * This subsystem's implementation is divided into three broad sections:
 * XXX update this
 *
 *    - A group of immutable, plain-old-JavaScript-classes that are essentially
 *      used as C-style structs.  These generally correspond to the objects in
 *      the Amon API:
 *
 *        - AmonAlarm
 *        - AmonFault
 *        - AmonProbe
 *        - AmonProbeGroup
 *
 *      plus ProbeTemplate, which describes the local metadata we have about
 *      probes and probe groups.
 *
 *    - A group of slightly richer classes that aid the implementation.  Some of
 *      these help walk the lower-level data structures in a way suitable for
 *      consumers, while others keep track of the state of ongoing operations.
 *
 *        - MantaAmonMetadata: represents the local information about the probe
 *          groups and probes that we know about, including knowledge articles
 *          for probe groups that we support today and knowledge about probe
 *          groups used by previous versions of the software.
 *
 *        - MantaAmonConfig: represents a set of probes and probe groups.  Each
 *          instance usually refers either to a set of objects already deployed
 *          or a set describing what we want to deploy.
 *
 *        - MantaAmonUpdatePlan: represents a set of operations necessary to
 *          move from one MantaAmonConfig (representing the currently deployed
 *          state) to another one (representing the desired state).
 *
 *        - MantaAmonUpdate: tracks the state of an ongoing operation to execute
 *          an update plan.
 *
 *        - MantaAmonAlarms: represents a set of alarms fetched from Amon.
 *          Callers use this together with the other classes to print
 *          information about active problems.
 *
 *     - A number of public functions for instantiating and working with these
 *       classes:
 *
 *        FETCHING STATE
 *
 *        - amonLoadMetadata: loads locally-stored metadata about Amon
 *          configuration
 *          XXX find me, rename me, move me
 *
 *        - amonLoadProbeGroups: fetches information about probe groups
 *
 *        - amonLoadOpenAlarms: fetches information about open alarms
 *          XXX rename me
 *
 *        - amonLoadComponentProbes: fetches detailed per-component probe
 *          information.
 *          XXX move and rename me
 *
 *        UPDATING CONFIGURATION
 *
 *        - amonUpdatePlanCreate: given two instances of MantaAmonConfig (a
 *          current and desired state of the world), generate a plan for moving
 *          from one to the other
 *
 *        - amonUpdatePlanSummarize: print out information about a plan
 *
 *        - amonUpdatePlanApply: execute an update plan
 */

var alarm_metadata = require('./metadata');
var alarm_alarms = require('./amon_alarms');
var alarm_config = require('./amon_config');
var alarm_update = require('./amon_config_update');

/* Exported interfaces */
exports.loadMetadata = alarm_metadata.loadMetadata;
exports.amonLoadOpenAlarms = alarm_alarms.amonLoadOpenAlarms;
exports.amonCloseAlarms = alarm_alarms.amonCloseAlarms;
exports.amonUpdateAlarmsNotification =
    alarm_alarms.amonUpdateAlarmsNotification;
exports.amonLoadProbeGroups = alarm_config.amonLoadProbeGroups;
exports.amonLoadComponentProbes = alarm_config.amonLoadComponentProbes;
exports.amonConfigSummarize = alarm_config.amonConfigSummarize;
exports.amonUpdatePlanCreate = alarm_update.amonUpdatePlanCreate;
exports.amonUpdatePlanSummarize = alarm_update.amonUpdatePlanSummarize;
exports.amonUpdatePlanApply = alarm_update.amonUpdatePlanApply;
