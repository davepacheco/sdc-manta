/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * lib/services.js: interfaces for working with deployed Manta services.  Much
 * service-related functionality still resides in other files inside this
 * module, but common pieces should wind up here.
 */

var assertplus = require('assert-plus');
var jsprim = require('jsprim');
var common = require('./common');

/* Public interface (used only within this module). */
exports.ServiceConfiguration = ServiceConfiguration;
exports.serviceIsSharded = serviceIsSharded;
exports.serviceConfigProperties = serviceConfigProperties;


/*
 * A "ServiceConfiguration" describes a count of service instances, grouped
 * based on unique "configurations" for that service.  For most services, the
 * "configuration" is just the image version for each instance.  This results in
 * a count of instances at each version.  For sharded services like "postgres"
 * and "moray", the "configuration" consists of both the shard number and image,
 * so the resulting counts are kept per (shard, image) tuple.  This class is
 * agnostic to what fields are part of the configuration.  Those are specified
 * in the constructor, as in:
 *
 *     svccfg = new ServiceConfiguration([ "IMAGE", "SH" ]);
 *
 * When you use each() to iterate the various configurations, you'll receive an
 * object describing each particular configuration, such as:
 *
 *     { "IMAGE": ..., "SH": 2 }
 *
 * which denotes a given image for shard 2.  Similarly, when you modify the
 * count using incr(), you must provide an object like the above one that
 * specifies a particular configuration whose count you're updating.
 *
 * "manta-adm update" uses several different ServiceConfiguration objects.
 * There may be a ServiceConfiguration per service per compute node that tracks
 * the number of instances of that service on each compute node, as well as a
 * group of fleet-wide per-service objects that track the total number of
 * instances of each service (and version, and shard) across the fleet.
 *
 * In general, we don't expect to have many configurations for a given service,
 * so we store this as a flat array.
 */
function ServiceConfiguration(keys)
{
	assertplus.ok(keys.length > 0);
	this.sc_keys = keys;
	this.sc_counts = [];
}

/*
 * Iterate the distinct configurations having non-zero values.  "callback" is
 * invoked for each one as callback(config, values), where "config" is an object
 * with key-value pairs for this configuration (e.g., "IMAGE" and "SH"), and
 * "values" is an array of the values for each of these fields (e.g., the
 * specific image and shard).
 */
ServiceConfiguration.prototype.each = function (callback)
{
	var self = this;
	this.sc_counts.forEach(function (config) {
		callback(config,
		    self.sc_keys.map(function (k) { return (config[k]); }));
	});
};

/*
 * Get the count of services having the specified configuration.  "config"
 * should be an object with the same fields passed in the constructor.
 */
ServiceConfiguration.prototype.get = function (config)
{
	var i, k;
	var key, row;
	for (i = 0; i < this.sc_counts.length; i++) {
		row = this.sc_counts[i];
		for (k = 0; k < this.sc_keys.length; k++) {
			key = this.sc_keys[k];
			if (config[key] != row[key])
				break;
		}

		if (k == this.sc_keys.length)
			return (row['count']);
	}

	return (0);
};

/*
 * Returns true if this object has a value for the given configuration.
 */
ServiceConfiguration.prototype.has = function (config)
{
	var i, k;
	var key, row;
	for (i = 0; i < this.sc_counts.length; i++) {
		row = this.sc_counts[i];
		for (k = 0; k < this.sc_keys.length; k++) {
			key = this.sc_keys[k];
			if (config[key] != row[key])
				break;
		}

		if (k == this.sc_keys.length)
			return (true);
	}

	return (false);
};

/*
 * Increment the count of instances associated with configuration "config" by
 * value "count".
 */
ServiceConfiguration.prototype.incr = function (config, count)
{
	var i, k;
	var key, row;

	if (arguments.length == 1)
		count = 1;

	for (i = 0; i < this.sc_counts.length; i++) {
		row = this.sc_counts[i];
		for (k = 0; k < this.sc_keys.length; k++) {
			key = this.sc_keys[k];
			if (config[key] != row[key])
				break;
		}

		if (k == this.sc_keys.length) {
			row['count'] += count;
			return;
		}
	}

	var obj = jsprim.deepCopy(config);
	obj['count'] = count;
	this.sc_counts.push(obj);
};

/*
 * Produce a plain-old-JavaScript-object summary (suitable for passing to
 * JSON.stringify()) of this service configuration.  Callers have committed to
 * this format, so care must be taken in changing this format.
 */
ServiceConfiguration.prototype.summary = function ()
{
	var rv = {};
	this.each(function (row, rowkey) {
		common.insert(rv, row['count'], rowkey);
	});
	return (rv);
};


/*
 * Given a service name, return whether that service is sharded.
 */
function serviceIsSharded(svcname)
{
	return (svcname == 'moray' || svcname == 'postgres');
}

/*
 * Given a service name, return an array of the properties typically used to
 * group instances of this service.  For most services, this is just the "image"
 * property -- instances should be grouped by their image version alone.  For
 * sharded services, the shard number is also relevant.
 */
function serviceConfigProperties(svcname)
{
	return (serviceIsSharded(svcname) ? [ 'SH', 'IMAGE' ] : [ 'IMAGE' ]);
}
