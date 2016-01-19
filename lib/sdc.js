/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * lib/sdc.js: library functions for working with SDC
 */

var assertplus = require('assert-plus');
var fs = require('fs');
var VError = require('verror').VError;

/* Public interface */
exports.sdcConfigPathDefault = '/usbkey/config';
exports.sdcReadAmqpConfig = sdcReadAmqpConfig;

/*
 * Given a path to an SDC configuration file "path", read the file and invoke
 * "callback" with an object mapping configuration variables to values for the
 * AMQP part of the configuration.  Failures to read the file will result in an
 * operational error passed to the callback.  However, failures to parse
 * individual lines are ignored.  The existing consumers of this function are
 * looking for pretty specific variables, so parse failure is no more meaningful
 * than failure to find those variables.  It would be useful to have a more
 * robust, general-purpose interface for this.
 */
function sdcReadAmqpConfig(path, callback)
{
	assertplus.string(path, 'path');
	assertplus.func(callback, 'callback');

	fs.readFile(path, function (err, data) {
		var lines, i, parts, p;

		if (err) {
			callback(new VError(err, 'read "%s"', path));
			return;
		}

		lines = data.toString('utf8').split('\n');
		for (i = 0; i < lines.length; i++) {
			parts = lines[i].split('=');
			if (parts.length != 2) {
				continue;
			}

			if (parts[0].trim() === 'rabbitmq') {
				break;
			}
		}

		if (i == lines.length) {
			callback(new VError(
			    '"rabbitmq" config not found in %s', path));
			return;
		}

		parts = parts[1].split(':');
		if (parts.length != 4 ||
		    isNaN(p = parseInt(parts[3], 10)) || p <= 0) {
			callback(new VError(
			    '"rabbitmq" config value not recognized'));
			return;
		}

		callback(null, {
		    'amqpHost': parts[2],
		    'amqpPort': p,
		    'amqpLogin': parts[0],
		    'amqpPassword': parts[1]
		});
	});
}
