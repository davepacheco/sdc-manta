/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017, Joyent, Inc.
 */

/*
 * lib/alarms/amon_objects.js: low-level Amon objects and their schemas
 * The classes in this file are used as simple structs, mostly with details
 * private to this subsystem.  Each class's fields mirror those in the Amon API.
 */

var assertplus = require('assert-plus');
var jsprim = require('jsprim');

var sprintf = require('extsprintf').sprintf;
var VError = require('verror');

var common = require('../common');

exports.loadAlarmObject = loadAlarmObject;
exports.loadProbeObject = loadProbeObject;
exports.loadProbeGroupObject = loadProbeGroupObject;

/*
 * This class is used as a struct, with details private to this subsystem.
 * The fields here mirror those in the Amon API for Alarms.
 */
function AmonAlarm(alarmdef)
{
	var self = this;

	assertplus.object(alarmdef, 'alarmdef');
	assertplus.number(alarmdef.id, 'alarmdef.id');
	assertplus.string(alarmdef.user, 'alarmdef.user');
	assertplus.optionalString(alarmdef.probeGroup, 'alarmdef.probeGroup');
	assertplus.bool(alarmdef.closed, 'alarmdef.closed');
	assertplus.bool(alarmdef.suppressed, 'alarmdef.suppressed');
	assertplus.number(alarmdef.timeOpened, 'alarmdef.timeOpened');
	assertplus.optionalNumber(alarmdef.timeClosed, 'alarmdef.timeClosed');
	assertplus.number(alarmdef.timeLastEvent, 'alarmdef.timeLastEvent');
	assertplus.number(alarmdef.numEvents, 'alarmdef.numEvents');
	assertplus.arrayOfObject(alarmdef.faults, 'alarmdef.faults');

	this.a_id = alarmdef.id;
	this.a_user = alarmdef.user;
	this.a_groupid = alarmdef.probeGroup;
	this.a_closed = alarmdef.closed;
	this.a_suppressed = alarmdef.suppressed;
	this.a_time_opened = new Date(alarmdef.timeOpened);
	this.a_time_closed = alarmdef.timeClosed ?
	    new Date(alarmdef.timeClosed) : null;
	this.a_time_last = new Date(alarmdef.timeLastEvent);
	this.a_nevents = alarmdef.numEvents;
	this.a_faults = alarmdef.faults.map(function (f) {
		return (new AmonFault(self, f));
	});
}

/*
 * This class is used as a struct, with details private to this subsystem.
 * The fields here mirror those in the Amon API under Alarms.
 */
function AmonFault(alarm, faultdef)
{
	assertplus.object(alarm, 'alarm');
	assertplus.ok(alarm instanceof AmonAlarm);
	assertplus.object(faultdef, 'faultdef');
	assertplus.string(faultdef.type, 'faultdef.type');
	assertplus.equal(faultdef.type, 'probe');
	assertplus.string(faultdef.probe, 'faultdef.probe');
	assertplus.object(faultdef.event, 'faultdef.event');
	assertplus.equal(faultdef.event.v, '1');
	assertplus.string(faultdef.event.type, 'faultdef.event.type');
	assertplus.equal(faultdef.event.type, 'probe');
	assertplus.bool(faultdef.event.clear, 'faultdef.event.clear');
	assertplus.string(faultdef.event.machine, 'faultdef.event.machine');
	assertplus.string(faultdef.event.uuid, 'faultdef.event.uuid');
	assertplus.string(faultdef.event.agent, 'faultdef.event.agent');
	assertplus.string(faultdef.event.agentAlias,
	    'faultdef.event.agentAlias');
	assertplus.number(faultdef.event.time, 'faultdef.event.time');
	assertplus.object(faultdef.event.data, 'faultdef.event.data');
	assertplus.string(faultdef.event.data.message,
	    'faultdef.event.data.message');

	this.aflt_alarm = alarm;
	this.aflt_probeid = faultdef.probe;
	/* XXX what does "clear" mean */
	this.aflt_clear = faultdef.event.clear;
	this.aflt_uuid = faultdef.event.uuid;
	this.aflt_machine = faultdef.event.machine;
	this.aflt_agent = faultdef.event.agent;
	this.aflt_agent_alias = faultdef.event.agentAlias;
	this.aflt_time = new Date(faultdef.event.time);

	/*
	 * XXX: I think we're going to want some sort of summary of the fault
	 * (e.g., "command timed out"), possibly with additional information
	 * (e.g., the command run, the exit status, etc.)
	 */
	this.aflt_summary = faultdef.event.data.message;
	this.aflt_data = faultdef.event.data;
}

/*
 * This class is used as a struct, with details private to this subsystem.
 * The fields here mirror those in the Amon API for Probes.  Because this can
 * represent probes that have not yet been created, the uuid is not required.
 * Most optional fields are "null" when not present, though "contacts" may
 * actually be not present.
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
	assertplus.bool(groupdef.disabled, 'groupdef.disabled');
	assertplus.arrayOfString(groupdef.contacts, 'groupdef.contacts');

	this.pg_name = groupdef.name;
	this.pg_user = groupdef.user;
	this.pg_uuid = groupdef.uuid;
	this.pg_contacts = groupdef.contacts.slice(0);
	this.pg_enabled = groupdef.disabled ? false : true;
}


/*
 * Schema helper functions
 */

/*
 * Given a JSON schema, return a schema that is exactly equivalent, but also
 * allows "null" values.
 */
function schemaAllowNull(type) {
	var rv = jsprim.deepCopy(type);
	assertplus.string(rv.type);
	rv.type = [ 'null', rv.type ];
	return (rv);
}

/*
 * Schemas
 */

var schemaTypeNonNegativeIntegerRequired = {
    'type': 'integer',
    'required': true,
    'minimum': 0
};

/*
 * XXX Test whether this field can be missing or just null.
 * If the latter, this needs to use schemaAllowNull instead.
 */
var schemaTypeUuidOptional = {
    'type': 'string',
    'minLength': 36,
    'maxLength': 36
};

var schemaTypeUuidRequired = {
    'type': 'string',
    'required': true,
    'minLength': 36,
    'maxLength': 36
};

var schemaTypeTimestampAsNumberRequired = {
    'type': 'number',
    'required': true,
    'minimum': 0
};

var schemaTypeAmonFault = {
    'type': 'object',
    'properties': {
	'type': { 'type': 'string', 'required': true },
	'probe': schemaTypeUuidRequired,
	'event': {
	    'type': 'object',
	    'required': true,
	    'properties': {
		'clear': { 'type': 'boolean', 'required': true },
		'machine': schemaTypeUuidRequired,
		'uuid': schemaTypeUuidRequired,
		'agent': schemaTypeUuidRequired,
		'agentAlias': { 'type': 'string', 'required': true },
		'time': schemaTypeTimestampAsNumberRequired,
		'data': {
		    'type': 'object',
		    'required': true,
		    'properties': {
			'message': {
			    'type': 'string',
			    'required': true
			}
		    }
		}
	    }
	}
    }
};

var schemaTypeAmonAlarm = {
    'type': 'object',
    'properties': {
	'id': schemaTypeNonNegativeIntegerRequired,
	'user': schemaTypeUuidRequired,
	'probeGroup': schemaTypeUuidOptional,
	'closed': { 'type': 'boolean', 'required': true },
	'suppressed': { 'type': 'boolean', 'required': true },
	'timeOpened': schemaTypeTimestampAsNumberRequired,
	'timeClosed': schemaAllowNull(schemaTypeTimestampAsNumberRequired),
	'timeLastEvent': schemaTypeTimestampAsNumberRequired,
	'numEvents': schemaTypeNonNegativeIntegerRequired,
	'faults': {
	    'type': 'array',
	    'items': schemaTypeAmonFault
	}
    }
};

var schemaTypeAmonContacts = {
    'type': 'array',
    'items': {
	'type': 'string'
    }
};

var schemaTypeAmonProbe = {
    'type': 'object',
    'properties': {
	/*
	 * See the comment on the AmonProbe class definition.  We allow "uuid"
	 * to be omitted for probes that have not yet been created.  That's
	 * different than it being null, which is what Amon does for most fields
	 * that are logically unspecified.
	 */
	'uuid': { 'type': 'string' },
	'name': { 'type': 'string', 'required': true },
	'type': { 'type': 'string', 'required': true },
	'config': { 'type': 'object', 'required': true },
	'agent': schemaTypeUuidRequired,
	'groupEvents': schemaAllowNull({ 'type': 'boolean', 'required': true }),
	'machine': schemaAllowNull(schemaTypeUuidRequired),

	/*
	 * "group" is not explicitly a uuid in the case of uncreated probes.
	 */
	'group': schemaAllowNull({ 'type': 'string', 'required': true }),

	/*
	 * Amon generally sets fields to "null" that are logically unspecified,
	 * but "contacts" is actually left out.
	 */
	'contacts': schemaTypeAmonContacts
    }
};

var schemaTypeAmonProbeGroup = {
    'type': 'object',
    'properties': {
	/*
	 * As with probes, the structure is a little looser to accommodate
	 * uncreated probe groups.
	 */
	'uuid': { 'type': 'string', 'required': true },
	/* XXX can users create probe groups without a name? */
	'name': { 'type': 'string', 'required': true },
	'user': schemaTypeUuidRequired,
	'contacts': schemaTypeAmonContacts,
	'disabled': { 'type': 'boolean', 'required': true }
    }
};

function loadAlarmObject(alarmdef)
{
	var error;

	error = jsprim.validateJsonObject(schemaTypeAmonAlarm, alarmdef);
	if (error !== null) {
		if (typeof (alarmdef.id) == 'number') {
			error = new VError(error, 'alarm %d', alarmdef.id);
		}

		return (error);
	}

	return (new AmonAlarm(alarmdef));
}

function loadProbeObject(probedef)
{
	var error;

	error = jsprim.validateJsonObject(schemaTypeAmonProbe, probedef);
	if (error !== null) {
		if (typeof (probedef.uuid) == 'string') {
			error = new VError(error, 'probe "%s"', probedef.uuid);
		}

		return (error);
	}

	return (new AmonProbe(probedef));
}

function loadProbeGroupObject(groupdef)
{
	var error;

	error = jsprim.validateJsonObject(schemaTypeAmonProbeGroup, groupdef);
	if (error !== null) {
		if (typeof (groupdef.uuid) == 'string') {
			error = new VError(error, 'probe group "%s"',
			    groupdef.uuid);
		}

		return (error);
	}

	return (new AmonProbeGroup(groupdef));
}
