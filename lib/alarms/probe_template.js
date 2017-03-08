/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * lib/alarms/probe_template.js: facilities for parsing probe template files
 */

var assert = require('assert-plus');
var fs = require('fs');
var jsprim = require('jsprim');
var jsyaml = require('js-yaml');
var path = require('path');
var vasync = require('vasync');
var VError = require('verror');

var amon_config = require('./amon_config');

/* Exported interface */
exports.loadProbeTemplates = loadProbeTemplates;
exports.ProbeTemplates = ProbeTemplates;

/*
 * Concurrency with which we load probe template files.
 */
var PTS_CONCURRENCY_FILES = 10;

/*
 * Load all of the probe templates from the specified directory.
 *
 * Named arguments include:
 *
 *     directory	path to directory containing all probe template files
 *     (string)
 *
 * "callback" is invoked upon completion as callback(err, templates).
 */
function loadProbeTemplates(args, callback)
{
	var pts;

	assert.object(args, 'args');
	assert.string(args.directory, 'args.directory');

	pts = new ProbeTemplates();
	pts.loadFromDirectory(args.directory, function onLoadDone() {
		var errors;

		errors = pts.errors();
		if (errors.length === 0) {
			callback(null, pts.pts_amoncfg);
		} else if (errors.length == 1) {
			callback(errors[0]);
		} else {
			callback(new VError.MultiError(errors));
		}
	});
}

/*
 * Represents the operation of loading a bunch of probe templates from
 * configuration files.
 */
function ProbeTemplates()
{
	/* problems encountered during load */
	this.pts_load_errors = [];

	/* probe templates found */
	this.pts_amoncfg = new amon_config.MantaAmonMetadata();

	/* for debugging only */
	this.pts_load_pipeline = null;
}

/*
 * Read YAML files in "directory" and load them.  Invokes "callback" upon
 * completion.  Errors and warnings are not passed to the callback.  See the
 * separate public methods for accessing those.
 */
ProbeTemplates.prototype.loadFromDirectory =
    function loadFromDirectory(directory, callback)
{
	var files;
	var queue;

	assert.string(directory, 'directory');
	assert.func(callback, 'callback');

	this.pts_load_pipeline = vasync.pipeline({
	    'arg': this,
	    'funcs': [
		function listDirectory(self, subcallback) {
			fs.readdir(directory,
			    function onReaddirDone(err, entries) {
				if (err) {
					err = new VError(err, 'readdir "%s"',
					    directory);
					self.pts_load_errors.push(err);
					subcallback();
					return;
				}

				files = entries.filter(function (e) {
					return (jsprim.endsWith(e, '.yaml'));
				}).map(function (e) {
					return (path.join(directory, e));
				});

				subcallback();
			    });
		},

		function readFiles(self, subcallback) {
			if (self.pts_load_errors.length > 0) {
				setImmediate(subcallback);
				return;
			}

			queue = vasync.queuev({
			    'concurrency': PTS_CONCURRENCY_FILES,
			    'worker': function loadQueueCallback(f, qcallback) {
				self.loadFromFile(f, qcallback);
			    }
			});

			files.forEach(function (f) { queue.push(f); });
			queue.on('end', function () { subcallback(); });
			queue.close();
		}
	    ]
	}, function (err) {
		/*
		 * Errors should be pushed onto pts_load_errors, not emitted
		 * here.
		 */
		assert.ok(!err);
		callback();
	});
};

/*
 * Read a single YAML file and load it.  Invokes "callback" upon completion.
 * Like loadFromDirectory(), errors and warnings are not passed to the callback,
 * but recorded for later.
 */
ProbeTemplates.prototype.loadFromFile =
    function loadFromFile(filename, callback)
{
	var self = this;
	var readoptions;

	assert.string(filename, 'filename');
	assert.func(callback, 'callback');

	readoptions = { 'encoding': 'utf8' };
	fs.readFile(filename, readoptions, function (err, contents) {
		var parsed;

		if (err) {
			err = new VError(err, 'read "%s"', filename);
			self.pts_load_errors.push(err);
			callback();
			return;
		}

		try {
			parsed = jsyaml.safeLoad(contents, {
			    'filename': filename
			});
		} catch (ex) {
			err = new VError(ex, 'parse "%s"', filename);
			self.pts_load_errors.push(err);
			callback();
			return;
		}

		parsed.forEach(function (p, i) {
			var error;
			error = self.pts_amoncfg.addTemplate({
			    'input': p,
			    'originLabel': filename + ': probe ' + (i + 1)
			});

			if (error) {
				self.pts_load_errors.push(error);
			}
		});

		callback();
	});
};

ProbeTemplates.prototype.errors = function ()
{
	return (this.pts_load_errors.slice());
};
