/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * lib/alarms/metadata.js: facilities for working with locally-provided metadata
 * about probes and probe groups.  See the block comment in lib/alarms/index.js
 * for details.
 *
 * This module exposes this function publicly:
 *
 *     loadMetadata: loads locally-provided metadata from files into a
 *     MantaAmonMetadata object
 *
 * that implicitly exposes this class:
 *
 *     MantaAmonMetadata: a class that provides basic methods for iterating the
 *     locally-provided metadata.  Instances of this class are immutable once
 *     constructed.
 *
 * This module exposes this function semi-privately (to other modules in this
 * directory):
 *
 *     probeGroupNameForTemplate: constructs a probe group name based on a probe
 *     template
 *
 * as well as the "MetadataLoader" for tools.
 */

var assertplus = require('assert-plus');
var fs = require('fs');
var jsprim = require('jsprim');
var jsyaml = require('js-yaml');
var path = require('path');
var vasync = require('vasync');
var VError = require('verror');

var services = require('../services');

/* Exported interface */
exports.loadMetadata = loadMetadata;
exports.probeGroupNameForTemplate = probeGroupNameForTemplate;
exports.MetadataLoader = MetadataLoader;

/*
 * Concurrency with which we load probe template files.
 */
var PTS_CONCURRENCY_FILES = 10;

/*
 * Load all of the probe template metadata from the specified directory.
 *
 * Named arguments include:
 *
 *     directory	path to directory containing all probe template files
 *     (string)
 *
 * "callback" is invoked upon completion as callback(err, metadata).
 */
function loadMetadata(args, callback)
{
	var mdl;

	assertplus.object(args, 'args');
	assertplus.string(args.directory, 'args.directory');

	mdl = new MetadataLoader();
	mdl.loadFromDirectory(args.directory, function onLoadDone() {
		var errors;

		errors = mdl.errors();
		/* XXX commonize */
		if (errors.length === 0) {
			callback(null, mdl.mdl_amoncfg);
		} else if (errors.length == 1) {
			callback(errors[0]);
		} else {
			callback(new VError.MultiError(errors));
		}
	});
}

/*
 * An instance of MantaAmonMetadata represents the local metadata associated
 * with probes and probe groups.  This is the primary exposed interface from
 * this module, though objects are only exposed through the loading interfaces.
 * (Outside consumers cannot create instances of this class directly.)
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
 * Public interfaces: for all callers
 */

/*
 * Public interface to return the knowledge article for an event called
 * "eventName".  Returns null if there is no knowledge article registered for
 * this event.
 *
 * See above for allowed callers.
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
 * Semi-private interfaces: for other files in this directory.
 */

/*
 * Iterate all registered probe templates.
 *
 * See above for allowed callers.
 */
MantaAmonMetadata.prototype.eachTemplate = function (func)
{
	jsprim.forEachKey(this.mam_templates_byevent, function (_, pt) {
		func(pt);
	});
};

/*
 * Given a probe group with name "probeGroupName", return the string name of the
 * event that is emitted when an alarm for this group fires.  This is primarily
 * useful for passing to the eventKa() function to get the knowledge article
 * associated with this probe group.  This function returns null if the event
 * name is unknown or not applicable (because it's an operator-created probe
 * group or the like).
 *
 * See above for allowed callers.
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
 * Given a probe group with name "probeGroupName", determine whether it should
 * be removed as part of a configuration update operation.  See the block
 * comment at the top of this file for an explanation of why we mark different
 * types of groups for removal.
 *
 * See above for allowed callers.
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
	return (eventName === null);
};


/*
 * Private interfaces: for this file only
 */

/*
 * Private interface to load a probe template into this data structure.  This
 * normally comes from the probe template files checked into this repository,
 * though the test suite can use this to load specific templates.
 *
 * See above for allowed callers.
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

/*
 * Resolve an event name that may be an alias to the underlying event name.
 * Returns null if this event is not known in this metadata.
 *
 * See above for allowed callers.
 */
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
 * This class is used as a struct, with details private to this subsystem.
 * The fields here closely mirror those in the probe template schema.  For
 * details, see the documentation for that.
 * XXX need to write that.
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


/*
 * Represents the operation of loading a bunch of probe templates from
 * configuration files.
 */
function MetadataLoader()
{
	/* problems encountered during load */
	this.mdl_load_errors = [];

	/* probe templates found */
	this.mdl_amoncfg = new MantaAmonMetadata();

	/* for debugging only */
	this.mdl_load_pipeline = null;
}

/*
 * Read YAML files in "directory" and load them.  Invokes "callback" upon
 * completion.  Errors and warnings are not passed to the callback.  See the
 * separate public methods for accessing those.
 */
MetadataLoader.prototype.loadFromDirectory =
    function loadFromDirectory(directory, callback)
{
	var files;
	var queue;

	assertplus.string(directory, 'directory');
	assertplus.func(callback, 'callback');

	this.mdl_load_pipeline = vasync.pipeline({
	    'arg': this,
	    'funcs': [
		function listDirectory(self, subcallback) {
			fs.readdir(directory,
			    function onReaddirDone(err, entries) {
				if (err) {
					err = new VError(err, 'readdir "%s"',
					    directory);
					self.mdl_load_errors.push(err);
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
			if (self.mdl_load_errors.length > 0) {
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
		 * Errors should be pushed onto mdl_load_errors, not emitted
		 * here.
		 */
		assertplus.ok(!err);
		callback();
	});
};

/*
 * Read a single YAML file and load it.  Invokes "callback" upon completion.
 * Like loadFromDirectory(), errors and warnings are not passed to the callback,
 * but recorded for later.
 */
MetadataLoader.prototype.loadFromFile =
    function loadFromFile(filename, callback)
{
	var self = this;
	var readoptions;

	assertplus.string(filename, 'filename');
	assertplus.func(callback, 'callback');

	readoptions = { 'encoding': 'utf8' };
	fs.readFile(filename, readoptions, function (err, contents) {
		var parsed;

		if (err) {
			err = new VError(err, 'read "%s"', filename);
			self.mdl_load_errors.push(err);
			callback();
			return;
		}

		try {
			parsed = jsyaml.safeLoad(contents, {
			    'filename': filename
			});
		} catch (ex) {
			err = new VError(ex, 'parse "%s"', filename);
			self.mdl_load_errors.push(err);
			callback();
			return;
		}

		parsed.forEach(function (p, i) {
			var error;
			error = self.mdl_amoncfg.addTemplate({
			    'input': p,
			    'originLabel': filename + ': probe ' + (i + 1)
			});

			if (error) {
				self.mdl_load_errors.push(error);
			}
		});

		callback();
	});
};

MetadataLoader.prototype.errors = function ()
{
	return (this.mdl_load_errors.slice());
};

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