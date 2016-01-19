/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * lib/adm.js: library interface to the "manta-oneach" functionality
 */

var assertplus = require('assert-plus');
var urclient = require('urclient');
var vasync = require('vasync');
var sdc = require('./sdc');
var madm = require('./adm');

var VError = require('verror').VError;

/* Public interface */
exports.mzValidateScopeParameters = mzValidateScopeParameters;
exports.mzCommandExecutor = mzCommandExecutor;

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
 * Arguments related to AMQP configuration:
 *
 *     amqpTimeout   number     AMQP connect timeout
 *
 *     amqpHost      [string]   hostname or IP address of AMQP server
 *     amqpPort      [number]   TCP port of AMQP server
 *     amqpLogin     [string]   AMQP authentication login
 *     amqpPassword  [string]   AMQP authentication password
 *     sdcConfigFile [string]   Path to SDC config file (usually /usbkey/config)
 *
 *     Either sdcConfigFile must be specified, or all of amqpHost, amqpPort,
 *     amqpLogin, and amqpPassword must be specified.  If both are specified,
 *     the configuration file will be used to fill in whichever of the other
 *     parameters are not specified.  amqpTimeout is never auto-configured.
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
 *     execCommand      string		shell command to execute
 *     					XXX specify exactly how: "bash -c" or
 *     					dropped into a script file or what
 *
 * Other arguments include:
 *
 *     streamStatus	stream		stream for text status reports
 *     					(e.g., process.stderr)
 *
 *     log		bunyan log	destination for log messages
 */
function mzCommandExecutor(args)
{
	var err;

	assertplus.object(args, 'args');

	/*
	 * AMQP parameters.
	 */
	if (args.sdcConfigFile !== null) {
		assertplus.string(args.sdcConfigFile, 'args.sdcConfigFile');
		assertplus.optionalString(args.amqpHost, 'args.amqpHost');
		assertplus.optionalString(args.amqpLogin, 'args.amqpLogin');
		assertplus.optionalString(args.amqpPassword,
		    'args.amqpPassword');
		assertplus.optionalNumber(args.amqpPort, 'args.amqpPort');
	} else {
		assertplus.string(args.amqpHost, 'args.amqpHost');
		assertplus.string(args.amqpLogin, 'args.amqpLogin');
		assertplus.string(args.amqpPassword, 'args.amqpPassword');
		assertplus.number(args.amqpPort, 'args.amqpPort');
	}

	assertplus.number(args.amqpTimeout, 'args.amqpTimeout');

	this.ce_amqp_host = args.amqpHost;
	this.ce_amqp_login = args.amqpLogin;
	this.ce_amqp_password = args.amqpPassword;
	this.ce_amqp_port = args.amqpPort;
	this.ce_amqp_timeout = args.amqpTimeout;
	this.ce_sdc_config_path = args.sdcConfigFile;

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

	this.ce_stream = args.streamStatus;
	this.ce_log = args.log;


	/*
	 * Helper objects
	 */
	this.ce_urclient = null;	/* client for Ur facility */
	this.ce_ur_ready = null;	/* time when we connected to AMQP */
	this.ce_manta = null;		/* MantaAdm object */
	this.ce_pipeline = null;	/* vasync pipeline for operation */
	this.ce_barrier = null;		/* vasync barrier for set up */
}

/*
 * Executes the operation defined by the configuration passed into the
 * constructor.  This is the only public interface in this class.
 */
mzCommandExecutor.prototype.execute = function (callback)
{
	var self = this;
	var funcs;

	assertplus.ok(this.ce_pipeline === null,
	    'CommandExecutor.execute() cannot be invoked more than once');
	assertplus.func(callback);

	funcs = [];

	if (this.ce_amqp_host === null ||
	    this.ce_amqp_login === null ||
	    this.ce_amqp_password === null ||
	    this.ce_amqp_timeout === null) {
		funcs.push(this.stageConfigAmqp.bind(this));
	}

	funcs.push(this.stageSetup.bind(this));
	funcs.push(this.stageIdentifyScope.bind(this));
	funcs.push(this.stageExecuteCommands.bind(this));
	funcs.push(this.stageDumpResults.bind(this));

	this.ce_pipeline = vasync.pipeline({
	    'funcs': funcs,
	    'arg': this
	}, function (err) {
		self.close();

		if (err) {
			err = new VError(err, 'executing command');
		}

		callback(err);
	});
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
	sdc.sdcReadAmqpConfig(this.ce_sdc_config_path, function (err, config) {
		if (err) {
			callback(new VError(err, 'auto-configuring AMQP'));
			return;
		}

		self.ce_log.trace(config, 'loaded amqp config');

		assertplus.string(config.amqpHost);
		if (self.ce_amqp_host === null) {
			self.ce_amqp_host = config.amqpHost;
		}

		assertplus.number(config.amqpPort);
		if (self.ce_amqp_port === null) {
			self.ce_amqp_port = config.amqpPort;
		}

		assertplus.string(config.amqpLogin);
		if (self.ce_amqp_login === null) {
			self.ce_amqp_login = config.amqpLogin;
		}

		assertplus.string(config.amqpPassword);
		if (self.ce_amqp_password === null) {
			self.ce_amqp_password = config.amqpPassword;
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
			self.ce_log.info('CommandExecutor ready');
			callback();
		} else {
			errors.forEach(function (err) {
				self.ce_log.error(err, 'setup error');
				self.ce_stream.write('setup error: ' +
				    err.message);
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

	this.ce_log.info(amqp, 'amqp config');
	this.ce_urclient = urclient.create_ur_client({
	    'log': this.ce_log.child({ 'component': 'UrClient' }),
	    'connect_timeout': this.ce_amqp_timeout,
	    'enable_http': false,
	    'amqp_config': amqp
	});

	this.ce_urclient.on('ready', function () {
		self.ce_log.info('ur client ready');
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
	/* XXX apply scope arguments */
	callback(new VError('not yet implemented'));
};

/*
 * Now that we've figured out which commands need to be executed where, go and
 * actually execute them.
 */
mzCommandExecutor.prototype.stageExecuteCommands = function (_, callback)
{
	/* XXX issue Ur commands, consider doing "discovery" first */
	callback(new VError('not yet implemented'));
};

/*
 * Now that we've executed the commands, print out the results.
 */
mzCommandExecutor.prototype.stageDumpResults = function (_, callback)
{
	/* XXX emit output the same way sdc-oneachnode does */
	callback(new VError('not yet implemented'));
};

/*
 * Cleans up any resources that we may be holding onto so that the process can
 * exit normally.
 */
mzCommandExecutor.prototype.close = function ()
{
	this.ce_log.info('close');

	if (this.ce_manta !== null) {
		this.ce_manta.close();
	}

	if (this.ce_urclient !== null) {
		this.ce_urclient.close();
	}
};
