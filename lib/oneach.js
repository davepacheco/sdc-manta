/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * lib/oneach.js: library interface to the "manta-oneach" functionality
 * TODO:
 * - output: in oneline mode, add header column row (and flag to turn it off)
 * - add support for --put / --get
 * - add automatic tests
 */

var assertplus = require('assert-plus');
var extsprintf = require('extsprintf');
var jsprim = require('jsprim');
var stream = require('stream');
var urclient = require('urclient');
var util = require('util');
var vasync = require('vasync');

var sdc = require('./sdc');
var madm = require('./adm');

var sprintf = extsprintf.sprintf;
var fprintf = extsprintf.fprintf;
var VError = require('verror').VError;

/* Public interface */
exports.mzValidateScopeParameters = mzValidateScopeParameters;
exports.mzCommandExecutor = mzCommandExecutor;
exports.mzResultToText = mzResultToText;
exports.mzResultToJson = mzResultToJson;

var mzScriptEofMarker = '288dd530';

/*
 * Given scope parameters that will be passed to mzCommandExecutor(), validate
 * that they're supported.  Returns an Error describing any failure, or null if
 * the parameters are valid.
 *
 * Note that type errors and the like are considered programmer errors: it's the
 * responsibility of the caller to construct a syntactically valid set of
 * parameters.  This function validates the semantics.
 */
function mzValidateScopeParameters(args)
{
	var havefilters;

	assertplus.optionalArrayOfString(args.scopeZones, 'args.scopeZones');
	assertplus.optionalArrayOfString(args.scopeServices,
	    'args.scopeServices');
	assertplus.optionalArrayOfString(args.scopeComputeNodes,
	    'args.scopeComputeNodes');
	assertplus.bool(args.scopeGlobalZones, 'args.scopeGlobalZones');
	assertplus.bool(args.scopeAllZones, 'args.scopeAllZones');

	havefilters = args.scopeComputeNodes !== null ||
	    args.scopeZones !== null || args.scopeServices !== null;

	if (args.scopeAllZones && havefilters) {
		return (new VError('cannot specify specific zones, services, ' +
		    'or compute nodes when all zones were requested'));
	}

	if (!args.scopeAllZones && !havefilters) {
		return (new VError('must explicitly request all zones ' +
		    'to operate on all zones'));
	}

	return (null);
}

/*
 * Manages the execution of a shell command on a subset of Manta components.
 * Any optional components that are not specified should be "null", not
 * "undefined" or missing.
 *
 *
 * ARGUMENTS
 *
 * Arguments related to AMQP configuration:
 *
 *     amqpTimeout        number     AMQP connect timeout
 *
 *     amqpHost           [string]   hostname or IP address of AMQP server
 *     amqpPort           number     TCP port of AMQP server
 *     amqpLogin          string     AMQP authentication login
 *     amqpPassword       string     AMQP authentication password
 *     sdcMantaConfigFile [string]   Path to sdc-manta config file (usually
 *				     use sdcMantaConfigPathDefault in ./sdc.js.)
 *
 *     At least one of sdcMantaConfigFile and amqpHost must be specified.  If
 *     both are specified, the specified amqpHost is used and the config file
 *     path not used.  The other AMQP parameters must always be specified.
 *
 * Arguments related to selecting the scope of operation.  The terminology here
 * matches how people tend to describe these components, but it's a little
 * confusing on the surface, so it's worth enumerating the kinds of components
 * in Manta:
 *
 *     (1) "Zones": implicitly, the non-global zones that operate most Manta
 *         services, including webapi, jobsupervisor, moray, postgres, and
 *         several others.  These never include "marlin" zones (also called
 *         "compute" zones), which are really their own thing.
 *
 *     (2) "Agents": namely, the Marlin agent, which runs in the global zone of
 *         Manta storage compute nodes.
 *
 *     (3) "Global zones": while the only Manta component that runs in global
 *         zones are the agents covered in (2), it's still useful while
 *         operating Manta to run commands in global zones that don't have
 *         anything to do with the agent.
 *
 *     (4) Marlin compute zones, where end user jobs are executed.
 *
 * We combine (2) and (3), since there's no actual difference in scope.  We
 * ignore (4) because it's very uncommon to want to run commands in compute
 * zones outside of Manta jobs themselves and because it's not generally safe to
 * do so shile jobs may be running (which is all the time).  That leaves us with
 * the unfortunately names "zones" and "global zones".
 *
 * Scope arguments include:
 *
 *     scopeAllZones	 boolean	Specifies a scope of all "zones"
 *     					(not "global zones").
 *
 *     scopeZones	 [string array]	Specifies a list of non-global zones
 *     					that will be part of the scope.
 *
 *     scopeServices	 [string array]	Specifies a list of Manta SAPI service
 *     					names whose zones should be part of the
 *     					scope.
 *
 *     scopeComputeNodes [string array] Specifies a list of compute nodes
 *     					whose non-global zones should be part of
 *     					the scope.
 *
 *     scopeGlobalZones  boolean	If true, then the scope represents the
 *     					_global_ zones for the zones that would
 *     					otherwise have been used.  See below for
 *     					examples.
 *
 * For safety, there is no default behavior.  Either "scopeAllZones" or some
 * combination of zones, services, or compute nodes must be requested (and not
 * both).
 *
 * If a combination of zones, services, or compute nodes is specified, then all
 * of these are applied as filters on the set of all zones.  The result is the
 * intersection of these sets.
 *
 * "scopeGlobalZones" is logically applied last, and changes the scope to match
 * the global zones for whatever components have been specified.
 *
 * Execution-related arguments include:
 *
 *     execTimeout	number		millisecond timeout for the execution
 *     					of the remote command
 *
 *     execCommand      string		shell command to execute.  This script
 *     					is executed as the body of a shell
 *     					script invoked with "bash".  It may
 *     					contain shell redirections, expansions,
 *     					and other special shell characters.
 *
 * Other arguments include:
 *
 *     concurrency	number		how many Ur commands may be outstanding
 *     					at one time
 *
 *     dryRun		boolean		indicates whether we'll actually
 *     					run the command or just report what
 *     					we would do
 *
 *     streamStatus	stream		stream for text status reports
 *     					(e.g., process.stderr)
 *
 *     log		bunyan log	destination for log messages
 *
 *
 * RESULTS
 *
 * This class is an object-mode ReadableStream that does NOT support flow
 * control.  The following events may be emitted (plus any others specified by
 * ReadableStream):
 *
 *     'error'          emitted when an operational error has been encountered
 *                      before execution of the requested command, such as a
 *                      failure to list Manta components or determining that a
 *                      given Manta service name was invalid.  No events will be
 *                      emitted after 'error'.  Per convention, the only
 *                      argument is the Error object itself.
 *
 *                      Failures of an individual command execution (including
 *                      timeouts, exiting with non-zero status, or being
 *                      terminated by a signal) will not show up as an 'error'.
 *                      These will be reported with the corresponding 'result'
 *                      object.
 *
 *     'data'           emitted when a result is available from a command
 *                      invocation.  The argument is an object with the
 *                      following properties, which are intended to be
 *                      compatible with the output of sdc-oneachnode(1) and
 *                      node-urclient:
 *
 *              uuid            string   the server_uuid where the command was
 *                                       executed
 *
 *              hostname        string   the hostname of the compute node where
 *                                       the command was executed
 *
 *              zonename        [string] the zonename in which the command was
 *                                       executed.  This will be present only if
 *                                       scopeGlobalZones was false.
 *
 *              service         [string] the SAPI service name for zone
 *                                       "zonename".  This will be present only
 *                                       if "zonename" is present.
 *
 *              result          [object] Ur result, which contains properties
 *                                       "exit_status", "stdout", and "stderr".
 *
 *              error           [object] Error, which contains at least
 *                                       properties "name" and "message".
 *
 *                      Exactly one of "error" or "result" will be present.
 *                      The presence of "error" indicates that either we
 *                      failed to execute the command at all or the status was
 *                      indeterminate because we failed to receive a response
 *                      before "execTimeout" milliseconds had elapsed.  "result"
 *                      will be present if the command was executed and we were
 *                      able to determine within the timeout that the command
 *                      either exited normally (possibly with a non-zero status
 *                      code) or abnormally (i.e., was terminated by a signal).
 *                      Note that you need to check "result" to determine
 *                      whether the command exited non-zero or was killed.
 *
 * Callers will likely want to pipe this stream into one of the output
 * formatters provided here.
 */
function mzCommandExecutor(args)
{
	var self = this;
	var err;

	assertplus.object(args, 'args');

	/*
	 * AMQP parameters.
	 */
	if (args.sdcMantaConfigFile !== null) {
		assertplus.string(args.sdcMantaConfigFile,
		    'args.sdcMantaConfigFile');
		assertplus.optionalString(args.amqpHost, 'args.amqpHost');
	} else {
		assertplus.string(args.amqpHost, 'args.amqpHost');
	}

	assertplus.string(args.amqpLogin, 'args.amqpLogin');
	assertplus.string(args.amqpPassword, 'args.amqpPassword');
	assertplus.number(args.amqpPort, 'args.amqpPort');
	assertplus.number(args.amqpTimeout, 'args.amqpTimeout');

	this.ce_amqp_host = args.amqpHost;
	this.ce_amqp_login = args.amqpLogin;
	this.ce_amqp_password = args.amqpPassword;
	this.ce_amqp_port = args.amqpPort;
	this.ce_amqp_timeout = args.amqpTimeout;
	this.ce_sdc_config_path = args.sdcMantaConfigFile;

	/*
	 * Scope parameters
	 */
	err = mzValidateScopeParameters(args);
	assertplus.ok(err === null, err ? err.message : null);
	this.ce_scope_all_zones = args.scopeAllZones;
	this.ce_scope_zones =
	    args.scopeZones === null ? null : args.scopeZones.slice(0);
	this.ce_scope_services =
	    args.scopeServices === null ? null : args.scopeServices.slice(0);
	this.ce_scope_cns = args.scopeComputeNodes;
	this.ce_scope_cns = args.scopeComputeNodes === null ? null :
	    args.scopeComputeNodes.slice(0);
	this.ce_scope_globals = args.scopeGlobalZones;

	this.ce_scope_allowed_services = {};
	madm.maSvcNamesOnEach.forEach(
	    function (s) { self.ce_scope_allowed_services[s] = true; });

	/*
	 * Command execution parameters
	 */
	assertplus.number(args.execTimeout, 'args.execTimeout');
	assertplus.string(args.execCommand, 'args.execCommand');
	this.ce_exec_timeout = args.execTimeout;
	this.ce_exec_command = args.execCommand;

	/*
	 * Other parameters
	 */
	assertplus.object(args.streamStatus, 'args.streamStatus');
	assertplus.object(args.streamStatus, 'args.log');
	assertplus.bool(args.dryRun, 'args.dryRun');
	assertplus.number(args.concurrency, 'args.concurrency');

	this.ce_stream = args.streamStatus;
	this.ce_log = args.log;
	this.ce_dryrun = args.dryRun;
	this.ce_concurrency = args.concurrency;


	/*
	 * Helper objects
	 */
	this.ce_urclient = null;	/* client for Ur facility */
	this.ce_ur_ready = null;	/* time when we connected to AMQP */
	this.ce_manta = null;		/* MantaAdm object */
	this.ce_pipeline = null;	/* vasync pipeline for operation */
	this.ce_barrier = null;		/* vasync barrier for set up */
	this.ce_queue = null;		/* vasync queue for Ur commands */

	/*
	 * Internal state
	 */
	this.ce_started = null;		/* Date when we started reading */

	/*
	 * Set of servers, by server_uuid.  Each server has:
	 *
	 *     s_hostname       (string) server hostname
	 *     s_server_uuid	(string) server uuid
	 *     s_cmds		(array)  list of zones assigned to this server,
	 *                               each as a "command".  Each has
	 *                               properties:
	 *
	 *         cmd_server_uuid  (string) server where this command is to run
	 *         cmd_service      (string) name of SAPI service for this zone
	 *         cmd_zonename     (string) name of this zone
	 *         cmd_command      (string) actual command to execute
	 *                                   (null if args.scopeGlobalZones is
	 *                                   true)
	 *         cmd_result       (object) describes result of each command
	 *
	 *     s_result		(object) result of command on this server
	 *                               (only when args.scopeGlobalZones is
	 *                               true)
	 */
	this.ce_servers = null;

	/* counter for operations started */
	this.ce_nstarted = 0;
	/* counter for operations completed, successfully or otherwise */
	this.ce_ncompleted = 0;
	/*
	 * counter for number of operations failed
	 * These represent failures to execute the command (e.g., failures at
	 * Ur, like a timeout), not cases where the command itself exited with a
	 * non-zero status or was killed.
	 */
	this.ce_nexecerrors = 0;

	stream.Readable.call(this, { 'objectMode': true });

	this.ce_log.info({
	    'amqpTimeout': args.amqpTimeout,
	    'amqpHost': args.amqpHost,
	    'amqpPort': args.amqpPort,
	    'amqpLogin': args.amqpLogin,
	    'amqpPassword': args.amqpPassword,
	    'sdcMantaConfigFile': args.sdcMantaConfigFile,
	    'scopeAllZones': args.scopeAllZones,
	    'scopeZones': args.scopeZones,
	    'scopeServices': args.scopeServices,
	    'scopeComputeNodes': args.scopeComputeNodes,
	    'scopeGlobalZones': args.scopeGlobalZones,
	    'execTimeout': args.execTimeout,
	    'execCommand': args.execCommand,
	    'concurrency': args.concurrency,
	    'dryRun': args.dryRun
	}, 'command executor created');
}

util.inherits(mzCommandExecutor, stream.Readable);

/*
 * The first call to _read() begins executing the operation defined by the
 * configuration passed into the constructor.  This stream does not support flow
 * control, so we ignore all future calls to _read().
 */
mzCommandExecutor.prototype._read = function ()
{
	var self = this;
	var funcs;

	if (this.ce_started !== null) {
		return;
	}

	this.ce_started = new Date();
	assertplus.ok(this.ce_pipeline === null,
	    'CommandExecutor.execute() cannot be invoked more than once');

	/*
	 * To enable users to use shell features (including operators like "&&",
	 * redirections, and parameter expansion), we pass their script to bash
	 * on stdin (rather than using "bash -c").  In order to do that from our
	 * own shell script (which is the primitive that Ur provides us), we use
	 * a heredoc using an EOF delimiter that we expect never to see in a
	 * user's script.  If we see this marker in the user's script, we'll
	 * detect that and bail out with an explicit error.
	 *
	 * Needless to say, we expect this would never happen outside of a
	 * deliberate test.  (The most plausible scenario is somebody's bash
	 * script containing a chunk of this file itself, presumably in some way
	 * that won't be interpreted as bash code, but this does not seem a
	 * critical use-case to support.)  If this becomes a problem, we could
	 * generate random marker strings until we find one that's not contained
	 * in the user's script.
	 */
	if (this.ce_exec_command.indexOf(mzScriptEofMarker) != -1) {
		setImmediate(this.emit.bind(this), 'error',
		    new VError('unsupported command (contains our marker)'));
		return;
	}

	funcs = [];

	if (this.ce_amqp_host === null ||
	    this.ce_amqp_login === null ||
	    this.ce_amqp_password === null ||
	    this.ce_amqp_timeout === null) {
		funcs.push(this.stageConfigAmqp.bind(this));
	}

	funcs.push(this.stageSetup.bind(this));
	funcs.push(this.stageIdentifyScope.bind(this));

	if (this.ce_dryrun) {
		funcs.push(this.stageDryrunCommands.bind(this));
	} else {
		funcs.push(this.stageExecuteCommands.bind(this));
	}

	this.ce_pipeline = vasync.pipeline({
	    'funcs': funcs,
	    'arg': this
	}, function (err) {
		assertplus.equal(self.ce_nstarted, self.ce_ncompleted);
		self.close();

		if (err) {
			self.ce_log.error(err, 'error');
			self.emit('error', err);
		} else {
			/* Emit 'end'. */
			self.ce_log.info('done');
			self.push(null);
		}
	});
};

/*
 * Returns the number of failures to execute a command on a remote host.  These
 * represent Ur-level failures or other failures not related to the command
 * itself.  If the command exited non-zero or was killed, that will not be
 * reflected here.
 */
mzCommandExecutor.prototype.nexecerrors = function ()
{
	return (this.ce_nexecerrors);
};

/*
 * This first stage reads AMQP configuration from the local SDC configuration
 * file.  This is only used when the AMQP configuration is not already fully
 * specified (as by command-line arguments).
 */
mzCommandExecutor.prototype.stageConfigAmqp = function (_, callback)
{
	var self = this;

	assertplus.string(this.ce_sdc_config_path);

	self.ce_log.trace({
	    'path': this.ce_sdc_config_path
	}, 'loading amqp config from file');

	sdc.sdcReadAmqpConfig(this.ce_sdc_config_path, function (err, config) {
		if (err) {
			callback(new VError(err, 'auto-configuring AMQP'));
			return;
		}

		self.ce_log.debug(config, 'loaded amqp config');

		/*
		 * There's currently no way for the port, login, or password to
		 * be specified by the configuration.  We could add it to the
		 * configuration file, but this information is not provided by
		 * SAPI, so it would be hardcoded in the config template anyway.
		 */
		assertplus.string(config.host);
		if (self.ce_amqp_host === null) {
			self.ce_amqp_host = config.host;
		}

		callback();
	});
};

/*
 * The setup stage initializes both an Ur client (for managing remote execution
 * of commands) and a MantaAdm client (used for figuring which commands need to
 * be executed on which compute nodes).  These are done in parallel to reduce
 * end user latency.
 */
mzCommandExecutor.prototype.stageSetup = function (_, callback)
{
	var self = this;
	var errors = [];
	var barrier;

	barrier = this.ce_barrier = vasync.barrier();
	barrier.on('drain', function () {
		if (errors.length === 0) {
			self.ce_log.debug('command executor ready');
			callback();
		} else {
			errors.forEach(function (err) {
				self.ce_log.error(err, 'setup error');
				if (errors.length > 1) {
					self.ce_stream.write('setup error: ' +
					    err.message + '\n');
				}
			});

			if (errors.length == 1) {
				callback(new VError(errors[0], 'setup error'));
			} else {
				callback(new VError('multiple setup errors'));
			}
		}
	});

	barrier.start('ur client');
	this.setupUrClient(function (err) {
		if (err) {
			errors.push(err);
		}

		barrier.done('ur client');
	});

	barrier.start('manta state');
	this.setupMantaState(function (err) {
		if (err) {
			errors.push(err);
		}

		barrier.done('manta state');
	});
};

/*
 * Initialize an Ur client.  Invokes "callback" upon completion with an optional
 * error.  The rest of the state is stored into "this".
 */
mzCommandExecutor.prototype.setupUrClient = function (callback)
{
	var self = this;
	var amqp;

	assertplus.string(this.ce_amqp_host);
	assertplus.number(this.ce_amqp_port);
	assertplus.string(this.ce_amqp_login);
	assertplus.string(this.ce_amqp_password);

	amqp = {
	    'host': this.ce_amqp_host,
	    'port': this.ce_amqp_port,
	    'login': this.ce_amqp_login,
	    'password': this.ce_amqp_password
	};

	this.ce_log.debug(amqp, 'amqp config');
	assertplus.ok(this.ce_urclient === null);
	this.ce_urclient = urclient.create_ur_client({
	    'log': this.ce_log.child({ 'component': 'UrClient' }),
	    'connect_timeout': this.ce_amqp_timeout,
	    'enable_http': false,
	    'amqp_config': amqp
	});

	this.ce_urclient.on('ready', function () {
		self.ce_log.debug('ur client ready');
		self.ce_ur_ready = new Date();
		callback();
	});

	this.ce_urclient.on('error', function (err) {
		callback(new VError(err, 'Ur client'));
	});
};

/*
 * Initialize a MantaAdm client and fetch all state about the current Manta
 * deployment.  Invokes "callback" upon completion with an optional error.  The
 * rest of the state is stored into "this".
 */
mzCommandExecutor.prototype.setupMantaState = function (callback)
{
	var self = this;

	assertplus.ok(this.ce_manta === null);

	this.ce_manta = new madm.MantaAdm(
	    this.ce_log.child({ 'component': 'MantaAdm' }));

	this.ce_manta.loadSdcConfig(function (err) {
		if (err) {
			callback(new VError(err, 'manta-adm load sdc config'));
			return;
		}

		self.ce_manta.fetchDeployed(function (err2) {
			if (err2) {
				callback(new VError(err2,
				    'manta-adm fetch deployed'));
				return;
			}

			self.ce_log.debug('MantaAdm data loaded');
			callback();
		});
	});
};

/*
 * Now that we've fetched details about all deployed Manta components, use the
 * scope parameters specified in the constructor to identify exactly which
 * commands need to be executed where.
 */
mzCommandExecutor.prototype.stageIdentifyScope = function (_, callback)
{
	var self = this;
	var err, count;

	this.ce_log.trace('identifying scope of operations');

	assertplus.ok(this.ce_servers === null);
	this.ce_servers = {};

	count = 0;
	err = this.ce_manta.eachZoneByFilter({
	    'scopeZones': this.ce_scope_zones,
	    'scopeServices': this.ce_scope_services,
	    'scopeComputeNodes': this.ce_scope_cns
	}, function (zoneinfo) {
		if (!self.ce_scope_allowed_services[zoneinfo['SERVICE']]) {
			self.ce_log.trace(zoneinfo,
			    'ignoring zone (disallowed service)');
			return;
		}

		/*
		 * "marlin" is not one of the whitelisted services, but
		 * double-check before we do anything else, since it's not safe
		 * to log into those zones while jobs may be running.
		 */
		assertplus.ok(zoneinfo['SERVICE'] != 'marlin');
		self.ce_log.trace(zoneinfo, 'found zone');

		if (!self.ce_servers.hasOwnProperty(
		    zoneinfo['SERVER_UUID'])) {
			self.ce_servers[zoneinfo['SERVER_UUID']] = {
			    's_hostname': zoneinfo['GZ HOST'],
			    's_server_uuid': zoneinfo['SERVER_UUID'],
			    's_cmds': [],
			    's_result': null
			};
		}

		self.ce_servers[zoneinfo['SERVER_UUID']].s_cmds.push({
		    'cmd_server_uuid': zoneinfo['SERVER_UUID'],
		    'cmd_service': zoneinfo['SERVICE'],
		    'cmd_zonename': zoneinfo['ZONENAME'],
		    'cmd_command': self.makeUrScript(zoneinfo['ZONENAME']),
		    'cmd_result': null
		});

		count++;
	});

	if (!err && count === 0) {
		err = new VError('no matching zones found');
	}

	setImmediate(callback, err);
};

/*
 * Now that we've figured out which commands need to be executed where, go and
 * actually execute them.
 */
mzCommandExecutor.prototype.stageDryrunCommands = function (_, callback)
{
	var self = this;

	assertplus.ok(this.ce_dryrun);
	if (this.ce_scope_globals) {
		jsprim.forEachKey(this.ce_servers, function (s) {
			fprintf(self.ce_stream, 'host %s: %s', s,
			    self.ce_exec_command);
		});
	} else {
		jsprim.forEachKey(this.ce_servers, function (s, server) {
			var cmds = server.s_cmds;
			fprintf(self.ce_stream, 'host %s: %d command%s\n',
			    s, cmds.length, cmds.length == 1 ? '' : 's');
			cmds.forEach(function (cmd) {
				fprintf(self.ce_stream,
				    '    zone %s: %s\n',
				    cmd.cmd_zonename, self.ce_exec_command);
			});
		});
	}

	fprintf(self.ce_stream,
	    '\nLeave off -n / --dry-run to execute.\n');
	setImmediate(callback);
};

/*
 * Now that we've figured out which commands need to be executed where, go and
 * actually execute them.
 */
mzCommandExecutor.prototype.stageExecuteCommands = function (_, callback)
{
	var queue;

	assertplus.ok(!this.ce_dryrun);
	assertplus.ok(this.ce_queue === null);

	this.ce_log.debug('begin execution');

	queue = this.ce_queue = vasync.queuev({
	    'concurrency': this.ce_concurrency,
	    'worker': this.queueExecuteCommand.bind(this)
	});

	queue.on('drain', function () { callback(); });

	if (this.ce_scope_globals) {
		jsprim.forEachKey(this.ce_servers, function (s) {
			queue.push(s);
		});
	} else {
		jsprim.forEachKey(this.ce_servers, function (s, server) {
			server.s_cmds.forEach(function (cmd) {
				queue.push(cmd);
			});
		});
	}

	queue.close();
};

/*
 * Cleans up any resources that we may be holding onto so that the process can
 * exit normally.
 */
mzCommandExecutor.prototype.close = function ()
{
	this.ce_log.debug('close');

	if (this.ce_manta !== null) {
		this.ce_manta.close();
	}

	if (this.ce_urclient !== null) {
		this.ce_urclient.close();
	}
};

/*
 * Construct an appropriate Ur script for the script that we're supposed to run
 * inside each zone.
 */
mzCommandExecutor.prototype.makeUrScript = function (zonename)
{
	var script;

	/*
	 * This function is only used to generate scripts to be executed within
	 * a non-global zone.  If we're operating on global zones, the returned
	 * script will not be used.
	 */
	if (this.ce_scope_globals) {
		return (null);
	}

	/*
	 * We've already validated this earlier, but make sure the script does
	 * not contain our own EOF marker.
	 */
	assertplus.equal(this.ce_exec_command.indexOf(mzScriptEofMarker), -1);

	/*
	 * Also make sure that our zonename does not contain anything other than
	 * the very restricted character set with which we create zonenames.  We
	 * want to be sure there will be no surprising behavior if the zonename
	 * was allowed to contain characters that are special to bash.
	 */
	assertplus.ok(/^[a-zA-Z0-9-]+/.test(zonename));

	/*
	 * This might be cleaner with sprintf() or with an external template,
	 * but then we'd have to escape characters in the user's script.  Stick
	 * with simple concatenation.  The reason we handle "113" specially is
	 * that Ur interprets this exit status to mean "reboot the server when
	 * complete", and we want to avoid that particular land mine in
	 * "manta-oneach".
	 */
	script = 'cat << \'' + mzScriptEofMarker + '\' | ' +
	        '/usr/sbin/zlogin -Q ' + zonename + ' bash /dev/stdin\n' +
	    this.ce_exec_command + '\n' +
	    mzScriptEofMarker + '\n' +
	    'rv=$?\n' +
	    'if [[ $rv -eq 113 ]]; then exit 1; else exit $rv ; fi';
	return (script);
};

/*
 * Given a command (described in the constructor), execute it.  Results are
 * placed back into "this".
 */
mzCommandExecutor.prototype.queueExecuteCommand = function (cmd, qcallback)
{
	var self = this;
	var urargs, summary;

	if (this.ce_scope_globals) {
		urargs = {
		    'server_uuid': cmd,
		    'timeout': this.ce_exec_timeout,
		    'script': this.ce_exec_command
		};
	} else {
		urargs = {
		    'server_uuid': cmd.cmd_server_uuid,
		    'timeout': this.ce_exec_timeout,
		    'script': cmd.cmd_command
		};
	}

	summary = {
	    'uuid': urargs['server_uuid'],
	    'hostname': this.ce_servers[urargs['server_uuid']].s_hostname
	};

	if (!this.ce_scope_globals) {
		summary['zonename'] = cmd.cmd_zonename;
		summary['service'] = cmd.cmd_service;
	}

	this.ce_log.debug(urargs, 'ur exec start');
	this.ce_nstarted++;
	this.ce_urclient.exec(urargs, function (err, result) {
		var internalResult;

		self.ce_ncompleted++;

		if (err) {
			self.ce_nexecerrors++;
			summary['error'] = err;
		} else {
			summary['result'] = result;
		}

		internalResult = {
		    'ur_err': err,
		    'ur_result': result
		};

		if (self.ce_scope_globals) {
			self.ce_servers[cmd].s_result = internalResult;
		} else {
			cmd.cmd_result = internalResult;
		}

		self.ce_log.debug(summary, 'ur exec done');
		self.push(summary);
		qcallback();
	});
};


/*
 * Result formatters
 */


/*
 * Transform stream that takes results from mzCommandExecutor and writes them in
 * a text format suitable for interactive use.
 */
function mzResultToText(args)
{
	assertplus.object(args, 'args');
	assertplus.bool(args.outputBatch, 'args.outputBatch');
	assertplus.string(args.multilineMode, 'args.multilineMode');
	assertplus.ok(args.multilineMode == 'one' ||
	    args.multilineMode == 'multi' || args.multilineMode == 'auto');

	stream.Transform.call(this, {
	    'objectMode': true,
	    'highWatermark': 16
	});

	this.rt_mode = args.multilineMode;
	this.rt_auto = 'one';
	this.rt_batch = args.outputBatch;
	this.rt_results = this.rt_batch ? [] : null;
}

util.inherits(mzResultToText, stream.Transform);

mzResultToText.prototype._transform = function (summary, _, callback)
{
	if (this.rt_batch) {
		if (this.rt_mode == 'auto' && this.rt_auto == 'one' &&
		    summary['result'] &&
		    summary['result']['stdout'].split('\n').length > 2) {
			this.rt_auto = 'multi';
		}

		this.rt_results.push(summary);
	} else {
		this.printResult(summary, this.rt_mode);
	}

	setImmediate(callback);
};

mzResultToText.prototype.printResult = function (summary, mode)
{
	var label, output, trailer, lines;

	if (summary['zonename']) {
		if (mode == 'multi') {
			label = sprintf('=== Output from %s on %s (%s):\n',
			    summary['zonename'], summary['hostname'],
			    summary['service']);
		} else {
			label = sprintf('%-16s %s ', summary['service'],
			    summary['zonename'].substr(0, 8));
		}
	} else {
		if (mode == 'multi') {
			/* This matches sdc-oneachnode's default output. */
			label = sprintf('=== Output from %s (%s):\n',
			    summary['uuid'], summary['hostname']);
		} else {
			label = sprintf('%-22s', summary['hostname']);
		}
	}

	if (summary['error']) {
		output = sprintf('ERROR: %s\n', summary['error'].message);
	} else {
		/*
		 * In one-line mode, we take only the last non-empty line.  When
		 * this mode was selected automatically, this is equivalent to
		 * the whole string, but if this mode was specifically requested
		 * by the user then this causes us to present only the last line
		 * of output.
		 */
		if (mode == 'multi') {
			output = summary['result']['stdout'];
		} else {
			lines = summary['result']['stdout'].
			    split('\n').filter(
			    function (l) { return (l.length > 0); });
			if (lines.length === 0) {
				output = '\n';
			} else {
				output = lines[lines.length - 1] + '\n';
			}
		}
	}

	trailer = mode == 'multi' ? '\n' : '';
	this.push(label + output + trailer);
};

mzResultToText.prototype._flush = function (callback)
{
	var self = this;
	var mode;

	if (this.rt_batch) {
		if (this.rt_mode == 'auto') {
			mode = this.rt_auto;
		} else {
			mode = this.rt_mode;
		}

		assertplus.ok(mode == 'one' || mode == 'multi');

		this.rt_results.sort(function (r1, r2) {
			var r;

			if (r1.hasOwnProperty('service')) {
				r = r1['service'].localeCompare(r2['service']);
				if (r !== 0) {
					return (r);
				}

				r = r1['zonename'].localeCompare(
				    r2['zonename']);
				if (r !== 0)
					return (r);
			}

			r = r1['hostname'].localeCompare(r2['hostname']);
			return (r);
		}).forEach(function (r) {
			self.printResult(r, mode);
		});
	}

	setImmediate(callback);
};

/*
 * Transform stream that takes results from mzCommandExecutor and writes them
 * directly in JSON form.
 */
function mzResultToJson()
{
	stream.Transform.call(this, {
	    'objectMode': true,
	    'highWatermark': 16
	});
}

util.inherits(mzResultToJson, stream.Transform);

mzResultToJson.prototype._transform = function (summary, _, callback)
{
	this.push(JSON.stringify(summary) + '\n');
	setImmediate(callback);
};
