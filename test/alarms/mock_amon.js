/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * mock_amon.js: implements a mock Amon server
 */

var assertplus = require('assert-plus');
var http = require('http');
var querystring = require('querystring');
var restifyClients = require('restify-clients');
var sdc = require('sdc-clients');
var url = require('url');
var VError = require('verror');

var account = 'mock-account-uuid';
var mockAmonPortBase = 20175;

/* Exported interface */
exports.createMockAmon = createMockAmon;
exports.account = account;

function createMockAmon(log, callback)
{
	var port, mock;

	assertplus.object(log, 'log');
	assertplus.func(callback, 'callback');

	port = mockAmonPortBase++;

	mock = { 'config': null };
	mock.url = 'http://127.0.0.1:' + port;
	mock.client = new sdc.Amon({
	    'log': log,
	    'url': mock.url,
	    'agent': false
	});

	mock.clientRaw = restifyClients.createJsonClient({
	    'log': log,
	    'url': mock.url,
	    'agent': false
	});

	mock.server = http.createServer(
	    function handleRequest(request, response) {
		mockAmonHandleRequest(mock.config, request, response);
	    });

	mock.server.listen(port, '127.0.0.1', function () {
		callback(mock);
	});
}

/*
 * HTTP request handler that implements our mock Amon server.  This only
 * supports the few requests that we need to implement, and it serves data based
 * on the contents of the "config" parameter, which comes from the "mock" object
 * that we gave back to the consumer.  In other words, the consumer controls
 * exactly what this server serves, and it can change it over time.  Supported
 * URLs are:
 *
 *     /pub/<account>/probegroups
 *
 *          The contents of the response are the JSON-encoded object at
 *          config.groups.  If this value is the special string 'error', then a
 *          500 error is returned instead.
 *
 *     /agentprobes?agent=AGENT
 *
 *          The contents of the response are the JSON-encoded object at
 *          config.agentprobes[AGENT] (where AGENT comes from the querystring).
 *          If this value is the special string 'error', then a 500 error is
 *          returned instead.
 *
 * Receiving any unsupported request or a request with bad arguments results in
 * an assertion failure.
 */
function mockAmonHandleRequest(config, request, response)
{
	var parsedurl, params, urlparts, value;

	assertplus.object(config, 'config');
	assertplus.object(config.agentprobes);

	parsedurl = url.parse(request.url);
	urlparts = parsedurl.pathname.split('/');
	if (urlparts.length == 4 &&
	    urlparts[0] === '' && urlparts[1] == 'pub' &&
	    urlparts[2] == account && urlparts[3] == 'probegroups') {
		value = config.groups;
	} else if (urlparts.length == 2 && urlparts[0] === '' &&
	    urlparts[1] == 'agentprobes') {
		params = querystring.parse(parsedurl.query);
		assertplus.string(params.agent,
		    'missing expected amon request parameter');
		value = config.agentprobes[params.agent];
	} else {
		throw (new VError('unimplemented URL: %s', request.url));
	}

	if (value == 'error') {
		response.writeHead(500, {
		    'content-type': 'application/json'
		});
		response.end(JSON.stringify({
		    'code': 'InjectedError',
		    'message': 'injected error'
		}));
	} else {
		response.writeHead(200);
		response.end(JSON.stringify(value));
	}
}
