/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * lib/layout.js: interfaces for laying out Manta services on a set of compute
 * nodes.
 *
 * TODO
 * - Add automated test suite
 * - Move more service configuration definition into lib/services.js (e.g.,
 *   legal service names) and build some interfaces for that
 * - Attempt to determine if a server will be oversubscribed.  We can work this
 *   out if we know the "size" of the deployment (i.e., "coal", "lab", or
 *   "production").  From that, we can pull up the memory and disk requirements
 *   from the files inside ./config inside this repository.
 */

var assertplus = require('assert-plus');
var fs = require('fs');
var jsprim = require('jsprim');
var vasync = require('vasync');
var VError = require('verror').VError;

var services = require('./services');

/* Public interface */
exports.generateLayoutFromFile = generateLayoutFromFile;

var ML_DEFAULT_AZ = 'default_az';
var ML_DEFAULT_RACK = 'default_rack';

/*
 * JSON schema for the server configuration file.  This is described in
 * manta-adm(1).
 */
var ML_SCHEMA = {
    'type': 'object',
    'additionalProperties': false,
    'properties': {
	'nshards': {
	    'required': true,
	    'type': 'integer',
	    'minimum': 1,
	    'maximum': 1024
	},
	'images': {
	    'type': 'object'
	},
	'servers': {
	    'required': true,
	    'type': 'array',
	    'minItems': 1,
	    'items': {
	        'type': 'object',
		'additionalProperties': false,
		'properties': {
		    'type': {
		        'type': 'string',
			'required': true,
			'enum': [ 'metadata', 'storage' ]
		    },
		    'uuid': {
		        'type': 'string',
			'required': true,
			'minLength': 1
		    },
		    'memory': {
			'type': 'integer',
			'required': true,
			'minimum': 1,
			'maximum': 1024
		    },
		    'az': {
		        'type': 'string',
			'minLength': 1
		    },
		    'rack': {
		        'type': 'string',
			'minLength': 1
		    }
		}
	    }
	}
    }
};

/*
 * The following objects configure broadly how many of each instance to deploy.
 * In terms of sizing, there are a few broad categories of service:
 *
 * (1) Singleton services.  For these, there must be exactly one instance per
 *     region.  Placement of these does not generally matter because they're
 *     low-impact and not part of the data or jobs path.
 *
 * (2) Small-count services.  For availability, we usually want at least two of
 *     each of these, but we don't generally need much more than that.  Like the
 *     singletons, placement does not hugely matter.
 *
 * (3) Per-shard services.  The user tells us how many shards they want because
 *     that's largely a function of desired operation capacity.  We deploy 3
 *     instances of each service per shard.  (Three is pretty fundamental to the
 *     way Manatee works, and it's a reasonable ratio for Moray as well.)  We'll
 *     attempt to minimize colocation of instances of the same per-shard service
 *     and maximize the number of metadata servers we use for this.  The easiest
 *     way to do this is to stripe these across all of the metadata servers.
 *
 * (4) Front door services.  We'll deploy a number of these proportional to the
 *     total number of metadata servers, and we stripe them across the metadata
 *     servers for balance.  The counts for these are purely heuristic.  They're
 *     not based on rigorous measurements of the relative capacities of the
 *     various services.
 *
 * (5) Totally ad-hoc special cases:
 *
 *        o "nameservice": three instances, no matter what.  We can operate with
 *          five, but it's not clear this provides increased resilience.
 *          Placement does not hugely matter.
 *
 *        o "storage": one zone per server designated as a storage server
 *
 *        o "marlin": computed based on DRAM of storage servers
 *
 * When we say that we'll stripe across metadata servers, we mean that we'll
 * put one instance on a metadata server, then another on the next server, and
 * so on until we need no more instances.  In order to maximize the likelihood
 * of surviving rack failure, we actually stripe across _racks_, picking one
 * server from each rack.  When we come to this rack again, we'll pick the next
 * server in the rack.  This process is deterministic.
 */

/*
 * ML_SERVICES_IGNORED are services that are not generally deployed.
 */
var ML_SERVICES_IGNORED = {
    'propeller': 0
};

/*
 * ML_SERVICES_SINGLETON lists the services that should be deployed exactly once
 * per region.  The values here must be 1.
 */
var ML_SERVICES_SINGLETON = {
    'ops': 1,
    'madtom': 1,
    'marlin-dashboard': 1
};

/*
 * ML_SERVICES_SMALL contains the list of services that can be deployed with
 * multiple instances, but only a very small number are expected to be needed in
 * each deployment.  These will be deployed in the specified counts.  We use 2
 * for availability, figuring that that's plenty of capacity for most
 * deployments.
 */
var ML_SERVICES_SMALL = {
    'jobsupervisor': 2,
    'jobpuller': 2,
    'medusa': 2
};

/*
 * ML_SERVICES_PER_SHARD describes the number of instances per shard for sharded
 * services.
 */
var ML_NPERSHARD_INSTANCES = 3;
var ML_SERVICES_PER_SHARD = {
    'postgres': ML_NPERSHARD_INSTANCES,
    'moray': ML_NPERSHARD_INSTANCES
};

/*
 * ML_SERVICE_RATIOS_FRONTDOOR describes the ratios used for services that make
 * up the front door.  These ratios will be multiplied by a factor determined by
 * the number of metadata servers.
 */
var ML_FRONTDOOR_NMAXINSTANCES = 8;
var ML_SERVICE_RATIOS_FRONTDOOR = {
    'authcache': 1,
    'electric-moray': ML_FRONTDOOR_NMAXINSTANCES,
    'webapi': ML_FRONTDOOR_NMAXINSTANCES,
    'loadbalancer': ML_FRONTDOOR_NMAXINSTANCES
};

/*
 * Percentage of DRAM that should be used for compute zones.  This errs on the
 * side of using too little DRAM on the grounds that it's easy to provision more
 * compute zones later.  Note that Marlin will also use some DRAM (not accounted
 * for here) as a slop pool that can be allocated to any compute zone.  See the
 * agent's "zoneMemorySlopPercent" configuration parameter.
 */
var ML_COMPUTE_DRAM_PERCENT = 0.25;

/*
 * Megabytes of DRAM that should be allocated for each compute zone by default.
 */
var ML_COMPUTE_DRAM_DEFAULT = 1024;

/*
 * Minimum number of compute zones per storage node.  Even for deployments that
 * don't intend to make much use of jobs, Manta itself uses them for garbage
 * collection, auditing, and the like, so we need a few zones on each storage
 * server to accommodate those.
 */
var ML_COMPUTE_NMIN = 4;


/*
 * Given a filename describing the available servers, generate a Manta
 * deployment layout.
 *
 *     filename		path to file describing servers
 *
 *     outstream	stream to write JSON form of final layout
 *
 *     images		image uuids, keyed by service name
 */
function generateLayoutFromFile(args, callback)
{
	assertplus.object(args, 'args');
	assertplus.string(args.filename, 'args.filename');
	assertplus.object(args.outstream, 'args.outstream');
	assertplus.object(args.images, 'args.images');
	assertplus.func(callback, 'callback');

	var filename, stream, images;
	var dcconfig;

	filename = args.filename;
	stream = args.outstream;
	images = args.images;
	dcconfig = new DatacenterConfig();

	return (vasync.waterfall([
	    function loadSubstrate(subcallback) {
		var loader = new SubstrateLoader({
		    'dcconfig': dcconfig,
		    'filename': filename
		});

		loader.start(subcallback);
	    },

	    function generate(subcallback) {
		var layout;

		layout = generateLayout({
		    'dcconfig': dcconfig,
		    'images': images
		});

		layout.dump(stream);
		subcallback(null, layout.ml_errors.length);
	    }
	], callback));
}


/*
 * Given a filename and an uninitialized DatacenterConfig, populates the region
 * dcconfig based on the contents of the file.  Arguments:
 *
 *     filename	 (string)  path to configuration file
 *
 *     dcconfig  (object)  uninitialized DatacenterConfig
 *
 * Invokes callback() upon completion, possibly with an error identifying
 * problems with the configuration.
 */
function SubstrateLoader(args)
{
	assertplus.object(args, 'args');
	assertplus.string(args.filename, 'args.filename');
	assertplus.object(args.dcconfig, 'args.dcconfig');

	/* Substrate we're going to load into */
	this.sl_dcconfig = args.dcconfig;
	/* Human-readable source of the datacenter configuration. */
	this.sl_source = 'file: ' + JSON.stringify(args.filename);
	this.sl_filename = args.filename;

	/* Input stream for datacenter configuration */
	this.sl_input = null;
	/* Accumulated data for datacenter configuration */
	this.sl_data = null;
	/* Parsed representation of datacenter configuration */
	this.sl_parsed = null;
	/* Errors accumulated during processing */
	this.sl_errors = [];
	/* We've finished the loading process */
	this.sl_done = false;
	/* Callback to invoke upon completion */
	this.sl_callback = null;
}

SubstrateLoader.prototype.start = function (callback)
{
	var self = this;

	assertplus.func(callback, 'callback');
	assertplus.ok(this.sl_callback === null,
	    'cannot re-use SubstrateLoader');

	this.sl_input = fs.createReadStream(this.sl_filename);
	this.sl_data = '';
	this.sl_errors = [];
	this.sl_callback = callback;

	this.sl_input.on('error', function (err) {
		self.sl_errors.push(new VError(err, self.sl_source));
		self.finish();
	});

	this.sl_input.on('data', function (chunk) {
		self.sl_data += chunk.toString('utf8');
	});

	this.sl_input.on('end', function () {
		self.parse();
	});
};

/*
 * Invoked when we've finished reading the input file and are ready to parse it.
 * This parses the JSON, validates it, and then loads it into the
 * DatacenterConfig object.
 */
SubstrateLoader.prototype.parse = function ()
{
	var dcconfig, err, svcname;
	var self = this;

	if (this.sl_errors.length === 0) {
		assertplus.string(this.sl_data);
		try {
			this.sl_parsed = JSON.parse(this.sl_data);
		} catch (ex) {
			this.sl_errors.push(
			    new VError(ex, 'parse %s', this.sl_source));
		}
	}

	if (this.sl_errors.length === 0) {
		err = jsprim.validateJsonObject(ML_SCHEMA, this.sl_parsed);
		if (err instanceof Error) {
			this.sl_errors.push(err);
		}

		if (this.sl_parsed.hasOwnProperty('images')) {
			for (svcname in this.sl_parsed['images']) {
				/* TODO validate service name */
				if (typeof (this.sl_parsed['images'][svcname])
				    != 'string') {
					this.sl_errors.push(new VError(
					    'images[%s]: not a string',
					    svcname));
					break;
				}
			}
		}
	}

	if (this.sl_errors.length > 0) {
		/*
		 * At this point, we can only have seen one error: either a
		 * failure to open or read the file or a failure to parse the
		 * contents.
		 */
		assertplus.equal(1, this.sl_errors.length);
		this.finish();
		return;
	}

	dcconfig = this.sl_dcconfig;
	dcconfig.dc_images = jsprim.deepCopy(this.sl_parsed['images']);

	/* This should be validated by the JSON schema. */
	assertplus.number(this.sl_parsed['nshards']);
	dcconfig.dc_nshards = this.sl_parsed['nshards'];
	assertplus.arrayOfObject(this.sl_parsed['servers']);
	this.sl_parsed['servers'].forEach(function (server) {
		var type, cn, rackname, rack, az;

		assertplus.ok(server !== null);
		assertplus.string(server['type']);
		type = server['type'];
		assertplus.string(server['uuid']);
		cn = server['uuid'];
		assertplus.number(server['memory']);

		assertplus.optionalString(server['rack']);
		if (server.hasOwnProperty('rack')) {
			rackname = server['rack'];
		} else {
			rackname = ML_DEFAULT_RACK;
		}

		assertplus.optionalString(server['az']);
		if (server.hasOwnProperty('az')) {
			az = server['az'];
		} else {
			az = ML_DEFAULT_AZ;
		}

		if (!dcconfig.dc_azs.hasOwnProperty(az)) {
			dcconfig.dc_az_names.push(az);
			dcconfig.dc_azs[az] = {
			    'rsaz_name': az,
			    'rsaz_rack_names': []
			};
		}

		if (!dcconfig.dc_racks.hasOwnProperty(rackname)) {
			dcconfig.dc_rack_names.push(rackname);
			rack = dcconfig.dc_racks[rackname] = {
			    'rsrack_az': az,
			    'rsrack_name': rackname,
			    'rsrack_servers_metadata': [],
			    'rsrack_servers_storage': []
			};
		} else {
			rack = dcconfig.dc_racks[rackname];
			if (rack.rsrack_az != az) {
				self.sl_errors.push(new VError(
				    'server %s, rack %s, az %s: rack already ' +
				    'exists in different az %s', cn, rackname,
				    az, rack.rsrack_az));
			}
		}

		if (dcconfig.dc_servers.hasOwnProperty(cn)) {
			self.sl_errors.push(new VError(
			    'server %s, rack %s, az %s: duplicate server',
			    cn, rackname, az));
		}

		dcconfig.dc_server_names.push(cn);
		dcconfig.dc_servers[cn] = {
		    'rscn_uuid': cn,
		    'rscn_rack': rackname,
		    'rscn_dram': server['memory']
		};

		if (type == 'metadata') {
			rack.rsrack_servers_metadata.push(cn);
			dcconfig.dc_servers_metadata.push(cn);
		} else {
			assertplus.equal(type, 'storage');
			rack.rsrack_servers_storage.push(cn);
			dcconfig.dc_servers_storage.push(cn);
		}
	});

	if (this.sl_errors.length > 0) {
		this.finish();
		return;
	}

	assertplus.deepEqual(Object.keys(dcconfig.dc_azs).sort(),
	    dcconfig.dc_az_names.slice(0).sort());
	assertplus.deepEqual(Object.keys(dcconfig.dc_racks).sort(),
	    dcconfig.dc_rack_names.slice(0).sort());
	assertplus.deepEqual(Object.keys(dcconfig.dc_servers).sort(),
	    dcconfig.dc_server_names.slice(0).sort());

	/* Validated by the JSON schema. */
	assertplus.ok(dcconfig.dc_server_names.length > 0);
	this.finish();
};

/*
 * Invoked exactly once for each instance when loading is complete, either as a
 * result of an error or normal completion.
 */
SubstrateLoader.prototype.finish = function ()
{
	assertplus.ok(!this.sl_done);
	this.sl_done = true;

	if (this.sl_errors.length > 0) {
		this.sl_callback(this.sl_errors[0]);
	} else {
		this.sl_callback();
	}
};

/*
 * The DatacenterConfig represents the set of datacenters, racks, and servers
 * that we have available for deploying Manta, along with configuration
 * properties that control the deployment (like the total number of shards).
 * This object must be initialized using the loadSubstrateFromFile function.
 * After that, it's an immutable plain-old-JavaScript-object.
 */
function DatacenterConfig()
{
	/*
	 * Availability zone information.  Each availability zone object has
	 * properties:
	 *
	 *    rsaz_name       (string) name of this availability zone
	 *    rsaz_rack_names (array)  list of rack identifiers in this AZ.
	 */
	/* list of az names in this region */
	this.dc_az_names = [];
	/* mapping of az names to availability zone objects (see above). */
	this.dc_azs = {};

	/*
	 * Rack information.  Rack names are assumed to be unique across all
	 * datacenters.  Each rack object has properties:
	 *
	 *     rsrack_name    		(string) name of this rack
	 *     rsrack_az      		(string) availability zone where this
	 *					 rack lives
	 *     rsrack_servers_metadata  (array)  list of uuids for metadata
	 *					 servers in this rack
	 *     rsrack_servers_storage   (array)  list of uuids for storage
	 *					 servers in this rack
	 */
	/* list of rack names in this region */
	this.dc_rack_names = [];
	/* mapping of rack names to rack objects (see above) */
	this.dc_racks = {};

	/*
	 * Server information.  Server names are assumed to be unique across all
	 * datacenters.  Each server object has properties:
	 *
	 *     rscn_uuid (string) unique identifier for this server
	 *     rscn_rack (string) name of the rack where this server lives
	 *     rscn_dram (number) gigabytes of memory available for Manta
	 */
	/* list of server names (uuids) */
	this.dc_server_names = [];
	/* mapping of server names to server objects (see above) */
	this.dc_servers = {};
	/* list of metadata server names */
	this.dc_servers_metadata = [];
	/* list of storage server names */
	this.dc_servers_storage = [];

	/* Number of metadata shards */
	this.dc_nshards = null;
	/* Image overrides */
	this.dc_images = null;
}

/*
 * A Layout represents a programmatic version of the "manta-adm update" ingest
 * file format.  (It might be nice to commonize this code with the "manta-adm
 * update" code.)
 */
function Layout()
{
	/* reference to dc config containing detailed metadata */
	this.ml_dcconfig = null;

	/* non-fatal problems with this layout */
	this.ml_warnings = [];

	/* fatal problems with this layout */
	this.ml_errors = [];

	/*
	 * mapping server uuid -> service name -> ServiceConfiguration
	 *
	 * Describes the instances deployed on each server.  This is the final
	 * output of this process.
	 */
	this.ml_configs_byserver = {};

	/*
	 * mapping of service name -> ServiceConfiguration
	 *
	 * Describes the instances deployed in the whole region.
	 */
	this.ml_configs_bysvcname = {};

	/*
	 * Mutable state used for allocation.  See allocateCn() for details.
	 *
	 *     o ml_racki is a set of rack indexes.
	 *
	 *     o ml_serveri is a set of server indexes within each rack.
	 *
	 * Each of these objects is keyed by a class of allocation.  This is
	 * just used to keep allocations orthogonal.  That is, multiple
	 * allocations with the same key (e.g., "datapath") will attempt to
	 * maximize spread across racks and servers, but allocations with
	 * different keys are assumed to be unrelated and may well overlap.
	 */
	this.ml_racki = {};
	this.ml_serveri = {};
}

/*
 * Within each allocation class, as described in the block comment above, we
 * stripe across racks first, then across servers within each rack.  That is, we
 * take:
 *
 *     rack 0, server 0
 *     rack 1, server 0
 *     rack 2, server 0
 *     ...
 *     rack 0, server 1
 *     rack 1, server 1
 *     rack 2, server 1
 *     ...
 *     rack 0, server 2
 *     ...
 *
 * We also support some racks being smaller than other racks.  In that case, we
 * still put the same number of services in each rack to maximize availability,
 * so they will be more densely packed in smaller racks.
 */
Layout.prototype.allocateMetadataCn = function (alloc_class)
{
	var ri, rackname, rack, rackservers, si, cnid;

	if (!this.ml_racki.hasOwnProperty(alloc_class)) {
		this.ml_racki[alloc_class] = 0;
		this.ml_serveri[alloc_class] = 0;
	}

	ri = this.ml_racki[alloc_class];
	assertplus.ok(ri < this.ml_dcconfig.dc_rack_names.length);
	rackname = this.ml_dcconfig.dc_rack_names[ri];
	assertplus.string(rackname);
	rack = this.ml_dcconfig.dc_racks[rackname];
	rackservers = rack.rsrack_servers_metadata;
	si = this.ml_serveri[alloc_class];
	cnid = rackservers[si % rackservers.length];

	if (++ri == this.ml_dcconfig.dc_rack_names.length) {
		ri = 0;
		si++;
	}

	this.ml_racki[alloc_class] = ri;
	this.ml_serveri[alloc_class] = si;

	return (cnid);
};

Layout.prototype.allocateInstance = function (cnid, svcname, config)
{
	if (!this.ml_configs_byserver.hasOwnProperty(cnid)) {
		this.ml_configs_byserver[cnid] = {};
	}
	if (!this.ml_configs_byserver[cnid].hasOwnProperty(svcname)) {
		this.ml_configs_byserver[cnid][svcname] =
		    new services.ServiceConfiguration(
		    services.serviceConfigProperties(svcname));
	}

	this.ml_configs_byserver[cnid][svcname].incr(config);

	if (!this.ml_configs_bysvcname.hasOwnProperty(svcname)) {
		this.ml_configs_bysvcname[svcname] =
		    new services.ServiceConfiguration(
		    services.serviceConfigProperties(svcname));
	}

	this.ml_configs_bysvcname[svcname].incr(config);
};

Layout.prototype.dump = function (stream)
{
	var config, cnids;
	var self = this;

	if (this.ml_errors.length > 0) {
		this.ml_errors.forEach(function (err) {
			stream.write('error: ' + err.message + '\n');
		});
		return;
	}

	/*
	 * For human verification, it's most convenient if the servers are
	 * grouped by type of node and the services are presented in order.
	 */
	config = {};
	cnids = this.ml_dcconfig.dc_servers_metadata.concat(
	    this.ml_dcconfig.dc_servers_storage);
	cnids.forEach(function (cnid) {
		var cfgs, svcnames;

		config[cnid] = {};
		assertplus.ok(self.ml_configs_byserver.hasOwnProperty(cnid));
		cfgs = self.ml_configs_byserver[cnid];
		svcnames = Object.keys(cfgs).sort();
		svcnames.forEach(function (svcname) {
			var svccfg = cfgs[svcname];
			config[cnid][svcname] = svccfg.summary();
		});
	});

	stream.write(JSON.stringify(config, null, '    ') + '\n');

	if (this.ml_warnings.length > 0) {
		this.ml_warnings.forEach(function (err) {
			stream.write('warning: ' + err.message + '\n');
		});
	}
};

/*
 * Generate a Layout from the given datacenter configuration.  This cannot fail,
 * but it can return a Layout that's unpopulated except for the list of fatal
 * errors.
 */
function generateLayout(args)
{
	var dcconfig, images, layout;

	assertplus.object(args, 'args');
	assertplus.object(args.dcconfig, 'args.dcconfig');
	assertplus.object(args.images, 'args.images');

	dcconfig = args.dcconfig;
	assertplus.number(dcconfig.dc_nshards);
	assertplus.ok(dcconfig.dc_az_names.length > 0);
	assertplus.ok(dcconfig.dc_rack_names.length > 0);
	assertplus.ok(dcconfig.dc_server_names.length > 0);

	/*
	 * We have a default set of images passed in by the caller, but these
	 * may be overridden by the images specified in the configuration file.
	 * This is primarily useful for getting consistent output files for
	 * testing purposes.
	 */
	images = jsprim.deepCopy(args.images);
	jsprim.forEachKey(dcconfig.dc_images, function (svcname, image) {
		images[svcname] = image;
	});

	layout = new Layout();
	layout.ml_dcconfig = dcconfig;

	if (dcconfig.dc_servers_metadata === 0 ||
	    dcconfig.dc_servers_storage === 0) {
		layout.ml_errors.push(new VError('need at least one ' +
		    'metadata server and one storage server'));
		return (layout);
	}

	if (dcconfig.dc_az_names.length > 1) {
		layout.ml_errors.push(new VError('multi-datacenter ' +
		    'deployments are not yet supported by this tool'));
		return (layout);
	}

	if (dcconfig.dc_nshards > dcconfig.dc_servers_metadata) {
		/*
		 * It doesn't make much sense to have more shards than metadata
		 * servers.  If you know at least two Manatee primaries will
		 * always be running on one host, what's the point of separating
		 * those into two shards?  It would usually make sense to just
		 * use fewer shards and expect the same performance.  Still,
		 * there can be exceptions, as for test environments, or
		 * environments that one expects to expand with new hardware
		 * (and where one would prefer to avoid resharding).  As a
		 * result, this is not a fatal error.
		 */
		layout.ml_warnings.push(new VError(
		    'requested %d shards with only %d metadata servers.  ' +
		    'Multiple primary databases will wind up running on the ' +
		    'same servers, and this configuration may not survive ' +
		    'server failure.  This is not recommended.',
		    dcconfig.dc_nshards, dcconfig.dc_servers_metadata.length,
		    dcconfig.dc_servers_metadata.length == 1 ? '' : 's'));
	} else if (ML_NPERSHARD_INSTANCES * dcconfig.dc_nshards >
	    dcconfig.dc_servers_metadata) {
		/*
		 * Strictly speaking, this case is just as bad as the previous
		 * one because you can wind up in the same state, with multiple
		 * primaries on the same server.  However, some operators may
		 * feel that it's a little better because they're not guaranteed
		 * to always be running in that degraded state.  The warning
		 * message is a little softer, but basically the same.
		 */
		layout.ml_warnings.push(new VError(
		    'requested %d shards with only %d metadata server%s.  ' +
		    'Under some conditions, multiple databases may wind up ' +
		    'running on the same servers.  This is not recommended.',
		    dcconfig.dc_nshards, dcconfig.dc_servers_metadata.length,
		    dcconfig.dc_servers_metadata.length == 1 ? '' : 's'));
	}

	if (dcconfig.dc_rack_names.length < 3) {
		layout.ml_warnings.push(new VError(
		    'configuration has only %d rack%s.  This configuration ' +
		    'may not surive rack failure.',
		    dcconfig.dc_rack_names.length,
		    dcconfig.dc_rack_names.length == 1 ? '' : 's'));
	}

	jsprim.forEachKey(images, function (svcname, image) {
		var count, alloc_class, cnid, i, j;

		if (ML_SERVICES_IGNORED.hasOwnProperty(svcname)) {
			return;
		}

		if (svcname == 'nameservice' ||
		    ML_SERVICES_SINGLETON.hasOwnProperty(svcname) ||
		    ML_SERVICES_SMALL.hasOwnProperty(svcname) ||
		    ML_SERVICE_RATIOS_FRONTDOOR.hasOwnProperty(svcname)) {
			assertplus.ok(!services.serviceIsSharded(svcname));

			if (svcname == 'nameservice') {
				alloc_class = 'small';
				count = 3;
			} else if (
			    ML_SERVICES_SINGLETON.hasOwnProperty(svcname)) {
				alloc_class = 'small';
				count = ML_SERVICES_SINGLETON[svcname];
				assertplus.equal(count, 1);
			} else if (ML_SERVICES_SMALL.hasOwnProperty(svcname)) {
				alloc_class = 'small';
				count = ML_SERVICES_SMALL[svcname];
				assertplus.number(count);
			} else {
				/*
				 * We allocate all frontdoor services from the
				 * same class to avoid overweighting the first
				 * servers in each rack.  This way, the count of
				 * all front door services on each server cannot
				 * differ by more than one across all servers.
				 */
				alloc_class = 'frontdoor';

				/*
				 * This calculation means that whichever
				 * frontdoor service(s) have the highest ratio
				 * get one instance per metadata server.  The
				 * rest are scaled down proportionally (as
				 * configured above).
				 */
				count = Math.ceil(
				    ML_SERVICE_RATIOS_FRONTDOOR[svcname] *
				    (dcconfig.dc_servers_metadata.length /
				    ML_FRONTDOOR_NMAXINSTANCES));
				assertplus.ok(count > 0);
				assertplus.ok(count <=
				    dcconfig.dc_servers_metadata.length);

				/*
				 * For availability, there should be at least
				 * two of each frontdoor service.
				 */
				count = Math.max(2, count);
			}

			for (i = 0; i < count; i++) {
				cnid = layout.allocateMetadataCn(alloc_class);
				layout.allocateInstance(cnid, svcname,
				    { 'IMAGE': image });
			}
		} else if (ML_SERVICES_PER_SHARD.hasOwnProperty(svcname)) {
			assertplus.ok(services.serviceIsSharded(svcname));
			for (i = 0; i < dcconfig.dc_nshards; i++) {
				for (j = 0; j < ML_NPERSHARD_INSTANCES; j++) {
					/*
					 * Per-shard services are allocated in
					 * their own allocation class so that
					 * different services are laid out the
					 * same way across the fleet (e.g.,
					 * moray instance "i" will be on the
					 * same CN as postgres instance "i").
					 * This relies on the deterministic
					 * nature of allocation to make sure
					 * that moray and postgres instances of
					 * the same shard are colocated.
					 */
					cnid = layout.allocateMetadataCn(
					    svcname);
					layout.allocateInstance(cnid, svcname, {
					    'SH': i + 1,
					    'IMAGE': image
					});
				}
			}
		} else if (svcname == 'storage') {
			dcconfig.dc_servers_storage.forEach(function (ocnid) {
				layout.allocateInstance(ocnid, svcname,
				    { 'IMAGE': image });
			});
		} else {
			assertplus.equal(svcname, 'marlin');
			dcconfig.dc_servers_storage.forEach(function (ocnid) {
				var server, avail_mb;

				server = dcconfig.dc_servers[ocnid];
				avail_mb = server.rscn_dram * 1024;
				avail_mb = ML_COMPUTE_DRAM_PERCENT * avail_mb;
				count = Math.floor(avail_mb /
				    ML_COMPUTE_DRAM_DEFAULT);
				count = Math.max(count, ML_COMPUTE_NMIN);

				for (i = 0; i < count; i++) {
					layout.allocateInstance(ocnid, svcname,
					    { 'IMAGE': image });
				}
			});
		}
	});

	return (layout);
}
