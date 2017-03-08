/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017 Joyent, Inc.
 */

/*
 * lib/alarms/amon.js: facilities for working with the AMON service
 */

var assertplus = require('assert-plus');
var progbar = require('progbar');
var vasync = require('vasync');
var VError = require('verror');
var MultiError = VError.MultiError;

/* Exported interface */
exports.amonFetchProbesForComponents = amonFetchProbesForComponents;

/*
 * Fetches AMON probe objects for all probes for the specified components.
 * Named arguments:
 *
 *     amon             a restify JSON client for the AMON master API
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
function amonFetchProbesForComponents(args, callback)
{
	var amoncfg, client, queue, errors, progress, ndone;

	assertplus.object(args, 'args');
	assertplus.object(args.amon, 'args.amon');
	assertplus.number(args.concurrency, 'args.concurrency');
	assertplus.arrayOfObject(args.components, 'args.components');
	assertplus.func(callback, 'callback');

	amoncfg = args.amoncfg;
	client = args.amon;
	errors = [];
	ndone = 0;
	if (process.stderr.isTTY) {
		progress = new progbar.ProgressBar({
		    'filename': 'fetching probes',
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
