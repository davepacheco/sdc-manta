/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * lib/alarms/amon_alarms.js: facilities for working with amon alarms.
 */

var assertplus = require('assert-plus');
var jsprim = require('jsprim');
var vasync = require('vasync');
var VError = require('verror');

/* Exported interface */
exports.amonLoadOpenAlarms = amonLoadOpenAlarms;
exports.amonCloseAlarms = amonCloseAlarms;


/*
 * Load information about open amon alarms.
 *
 * Named arguments:
 *
 *     account         Triton account uuid whose open alarms to load
 *
 *     amon            Amon client (from sdc-clients)
 */
function amonLoadOpenAlarms(args, callback)
{
	var amon, account, rv, options;

	assertplus.object(args, 'args');
	assertplus.string(args.account, 'args.account');
	assertplus.object(args.amon, 'args.amon');

	amon = args.amon;
	account = args.account;
	rv = new MantaAmonAlarms();
	options = { 'state': 'open' };

	amon.listAlarms(account, options, function (err, rawalarms) {
		if (err) {
			err = new VError(err, 'listing open alarms');
			callback(err);
			return;
		}

		rawalarms.forEach(function (rawalarm) {
			/* XXX validate */
			var alarm = new AmonAlarm(rawalarm);
			assertplus.ok(
			    !rv.mas_alarms_byid.hasOwnProperty(alarm.a_id),
			    'received multiple alarms with the id ' +
			    alarm.a_id);
			rv.mas_alarms.push(alarm);
			rv.mas_alarms_byid[alarm.a_id] = alarm;
		});

		callback(null, rv);
	});
}

/*
 * Closes the specified open alarms.
 *
 * Named arguments:
 *
 *     account         Triton account uuid whose open alarms to load
 *
 *     amon            Amon client (from sdc-clients)
 *
 *     alarmIds	       array of alarm ids to close
 *
 *     concurrency     maximum request concurrency
 *
 * This is an array-based interface in order to better support parallelizing
 * operations.  This could also expose an object-mode stream interface.
 */
function amonCloseAlarms(args, callback)
{
	var account, amon, queue, errors;

	assertplus.object(args, 'args');
	assertplus.string(args.account, 'args.account');
	assertplus.object(args.amon, 'args.amon');
	assertplus.arrayOfString(args.alarmIds, 'args.alarmIds');
	assertplus.number(args.concurrency, 'args.concurrency');

	account = args.account;
	amon = args.amon;
	errors = [];
	queue = vasync.queuev({
	    'concurrency': args.concurrency,
	    'worker': function closeAlarm(alarmid, qcallback) {
		/*
		 * External to this file, we avoid assuming that alarm ids are
		 * positive integers.  That's an amon-ism.  But the client
		 * library does assume that, so here's where we have to validate
		 * it.
		 */
		var num;

		num = jsprim.parseInteger(alarmid);
		if (typeof (num) == 'number' && num < 1) {
			num = VError('not a positive integer');
		}

		if (num instanceof Error) {
			errors.push(new VError(num,
			    'close alarm "%s"', alarmid));
			qcallback();
			return;
		}

		amon.closeAlarm(account, num, function onAmonClose(err) {
			if (err) {
				err = new VError(err,
				    'close alarm "%s"', alarmid);
				errors.push(err);
			}

			qcallback();
		});
	    }
	});

	args.alarmIds.forEach(function (a) { queue.push(a); });

	queue.on('end', function () {
		/* XXX use commonized MultiError code */
		callback(null, errors);
	});

	queue.close();
}

/*
 * Represents a set of open amon alarms.
 */
function MantaAmonAlarms()
{
	/* list of open alarms */
	this.mas_alarms = [];

	/* alarms indexed by id */
	this.mas_alarms_byid = {};
}

MantaAmonAlarms.prototype.eachAlarm = function (func)
{
	this.mas_alarms.forEach(function (aa) {
		func(aa.a_id, aa);
	});
};

MantaAmonAlarms.prototype.alarmForId = function (id)
{
	return (this.mas_alarms_byid.hasOwnProperty(id) ?
	    this.mas_alarms_byid[id] : null);
};

/*
 * Classes used as simple structs
 */

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
