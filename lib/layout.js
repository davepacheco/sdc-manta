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
 * nodes
 * XXX working on layout generator -- see "not yet implemented"
 */

var assertplus = require('assert-plus');
var fs = require('fs');
var jsprim = require('jsprim');
var vasync = require('vasync');
var VError = require('verror').VError;

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
			'minimum': 1,
			'maximum': 1024
		    },
		    'disk': {
			'type': 'integer',
			'minimum': 1,
			'maximum': 1024 * 1024
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
	var substrate;

	filename = args.filename;
	stream = args.outstream;
	images = args.images;
	substrate = new RegionSubstrate();

	return (vasync.waterfall([
	    function loadSubstrate(subcallback) {
		loadSubstrateFromFile({
		    'substrate': substrate,
		    'filename': filename
		}, subcallback);
	    },

	    function generate(subcallback) {
		var layout;

		layout = generateLayout({
		    'substrate': substrate,
		    'images': images
		});
		layout.dump(stream);
		subcallback();
	    }
	], callback));
}

/*
 * Given a filename and an uninitialized RegionSubstrate, populate the region
 * substrate based on the contents of the file.  Invokes callback() upon
 * completion, possibly with an error identifying problems with the
 * configuration.
 *
 *     filename	 (string)  path to configuration file
 *
 *     substrate (object)  uninitialized RegionSubstrate
 */
function loadSubstrateFromFile(args, callback)
{
	var loader;

	assertplus.object(args, 'args');
	assertplus.string(args.filename, 'args.filename');
	assertplus.object(args.substrate, 'args.substrate');
	assertplus.func(callback, 'callback');

	loader.sl_substrate = args.substrate;
	loader.sl_source = 'file: ' + JSON.stringify(args.filename);
	loader.sl_input = fs.createReadStream(args.filename);
	loader.sl_data = '';
	loader.sl_errors = [];
	loader.sl_callback = callback;

	this.sl_input.on('error', function (err) {
		loader.sl_errors.push(new VError(err, loader.sl_source));
		loader.finish();
	});

	this.sl_input.on('data', function (chunk) {
		loader.sl_data += chunk.toString('utf8');
	});

	this.sl_input.on('end', function () {
		loader.parse();
	});
}

/*
 * Represents the state of an asynchronous operation used to load a
 * RegionSubstrate.
 */
function SubstrateLoader()
{
	/* Substrate we're going to load */
	this.sl_substrate = null;
	/* Human-readable source of the substrate configuration. */
	this.sl_source = null;
	/* Input stream for substrate configuration */
	this.sl_input = null;
	/* Accumulated data for substrate configuration */
	this.sl_data = null;
	/* Parsed representation of substrate configuration */
	this.sl_parsed = null;
	/* Errors accumulated during processing */
	this.sl_errors = [];
	/* We've finished the loading process */
	this.sl_done = false;
	/* Callback to invoke upon completion */
	this.sl_callback = null;
}

/*
 * Invoked when we've finished reading the input file and are ready to parse it.
 * This parses the JSON, validates it, and then loads it into the
 * RegionSubstrate object.
 */
SubstrateLoader.prototype.parse = function ()
{
	var substrate, err;
	var self = this;

	assertplus.ok(!this.sl_done);
	this.sl_done = true;

	if (this.sl_errors.length === 0) {
		assertplus.string(this.sl_data);
		try {
			this.sl_parsed = JSON.parse(this.sl_data);
		} catch (ex) {
			this.sl_errors.push(
			    new VError(err, 'parse %s', this.sl_source));
		}
	}

	if (this.sl_errors.length === 0) {
		err = jsprim.validateJsonObject(ML_SCHEMA, this.sl_parsed);
		if (err instanceof Error) {
			this.sl_errors.push(err);
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

	substrate = this.sl_substrate;
	/* This should be validated by the JSON schema. */
	assertplus.number(this.sl_parsed['nshards']);
	substrate.rs_nshards = this.sl_parsed['nshards'];
	assertplus.arrayOfObject(this.sl_parsed['servers']);
	this.sl_parsed['servers'].forEach(function (server) {
		var type, cn, rackname, rack, az;

		assertplus.ok(server !== null);
		assertplus.string(server['type']);
		type = server['type'];
		assertplus.string(server['uuid']);
		cn = server['uuid'];
		assertplus.number(server['memory']);
		assertplus.number(server['disk']);

		assertplus.optionalString(server['rack']);
		if (server.hasOwnProperty('rackname')) {
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

		if (!substrate.rs_azs.hasOwnProperty(az)) {
			substrate.rs_az_names.push(az);
			substrate.rs_azs[az] = {
			    'rsaz_name': az,
			    'rsaz_rack_names': []
			};
		}

		if (!substrate.rs_racks.hasOwnProperty(rackname)) {
			substrate.rs_rack_names.push(rackname);
			rack = substrate.rs_racks[rackname] = {
			    'rsrack_az': az,
			    'rsrack_name': rackname,
			    'rsrack_servers_metadata': [],
			    'rsrack_servers_storage': []
			};
		} else {
			rack = substrate.rs_racks[rackname];
			if (rack.rsrack_az != az) {
				self.sl_errors.push(new VError(
				    'server %s, rack %s, az %s: rack already ' +
				    'exists in different az %s', cn, rackname,
				    az, rack.rsrack_az));
			}
		}

		if (type == 'metadata') {
			rack.rsrack_servers_metadata.push(cn);
		} else {
			assertplus.equal(type, 'storage');
			rack.rsrack_servers_storage.push(cn);
		}

		if (substrate.rs_servers.hasOwnProperty(cn)) {
			self.sl_errors.push(new VError(
			    'server %s, rack %s, az %s: duplicate server',
			    cn, rackname, az));
		}

		substrate.rs_server_names.push(cn);
		substrate.rs_servers[cn] = {
		    'rscn_uuid': cn,
		    'rscn_rack': rackname,
		    'rscn_dram': server['memory'],
		    'rscn_disk': server['disk']
		};

		if (type == 'metadata') {
			substrate.rs_servers_metadata.push(cn);
		} else {
			assertplus.equal(type, 'storage');
			substrate.rs_servers_storage.push(cn);
		}
	});

	if (this.sl_errors.length > 0) {
		this.finish();
		return;
	}

	assertplus.deepEqual(Object.keys(substrate.rs_az).sort(),
	    substrate.rs_az_names.slice(0).sort());
	assertplus.deepEqual(Object.keys(substrate.rs_racks).sort(),
	    substrate.rs_rack_names.slice(0).sort());
	assertplus.deepEqual(Object.keys(substrate.rs_servers).sort(),
	    substrate.rs_server_names.slice(0).sort());

	/* Validated by the JSON schema. */
	assertplus.ok(substrate.rs_server_names.length > 0);
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
 * The RegionSubstrate represents the set of datacenters, racks, and servers
 * that we have available for deploying Manta.  This object must be initialized
 * using the loadSubstrateFromFile function.  After that, it's an immutable
 * plain-old-JavaScript-object.
 */
function RegionSubstrate()
{
	/*
	 * Availability zone information.  Each availability zone object has
	 * properties:
	 *
	 *    rsaz_name       (string) name of this availability zone
	 *    rsaz_rack_names (array)  list of rack identifiers in this AZ.
	 */
	/* list of az names in this region */
	this.rs_az_names = [];
	/* mapping of az names to availability zone objects (see above). */
	this.rs_azs = {};

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
	this.rs_rack_names = [];
	/* mapping of rack names to rack objects (see above) */
	this.rs_racks = {};

	/*
	 * Server information.  Server names are assumed to be unique across all
	 * datacenters.  Each server object has properties:
	 *
	 *     rscn_uuid (string) unique identifier for this server
	 *     rscn_rack (string) name of the rack where this server lives
	 *     rscn_dram (number) gigabytes of memory available for Manta
	 *     rscn_disk (number) gigabytes of disk available for Manta
	 */
	/* list of server names (uuids) */
	this.rs_server_names = [];
	/* mapping of server names to server objects (see above) */
	this.rs_servers = {};
	/* list of metadata server names */
	this.rs_servers_metadata = [];
	/* list of storage server names */
	this.rs_servers_storage = [];

	/* Number of metadata shards */
	this.rs_nshards = null;
}

/*
 * A Layout represents a programmatic version of the "manta-adm update" ingest
 * file format.  (It might be nice to commonize this code with the "manta-adm
 * update" code.)
 */
function Layout()
{
	/* reference to substrate containing detailed metadata */
	this.ml_substrate = null;

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
 *
 * XXX consider DRAM, disk constraints?  Just warn of they're violated?
 */
Layout.prototype.allocateMetadataCn = function (alloc_class)
{
	var ri, rackname, rack, rackservers, si, cnid;

	if (!this.ml_racki.hasOwnProperty(alloc_class)) {
		this.ml_racki[alloc_class] = 0;
		this.ml_serveri[alloc_class] = 0;
	}

	ri = this.ml_racki[alloc_class];
	assertplus.ok(ri < this.ml_substrate.rs_rack_names.length);
	rackname = this.ml_substrate.rs_rack_names[ri];
	assertplus.string(rackname);
	rack = this.ml_substrate.rs_racks[rackname];
	rackservers = rack.rsrack_servers_metadata;
	si = this.ml_serveri[alloc_class];
	cnid = rackservers[si % rackservers.length];

	if (++ri == this.ml_substrate.rs_rack_names.length) {
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
		/*
		 * XXX The ServiceConfiguration class needs to be commonized so
		 * that we can use it.
		 * XXX The ServiceConfiguration constructor argument needs to
		 * come from the same place it does in lib/adm.js.
		 */
		this.ml_configs_byserver[cnid][svcname] =
		    new ServiceConfiguration();
	}

	this.ml_configs_byserver[cnid][svcname].incr(config);

	if (!this.ml_configs_bysvcname.hasOwnProperty(svcname)) {
		/* XXX See above. */
		this.ml_configs_bysvcname[svcname] = new ServiceConfiguration();
	}

	this.ml_configs_bysvcname[svcname].incr(config);
};

/*
 * Generate a Layout from the given substrate.  This cannot fail, but it can
 * return a Layout that's unpopulated except for the list of fatal errors.
 */
function generateLayout(args)
{
	var substrate, images, layout;

	assertplus.object(args, 'args');
	assertplus.object(args.substrate, 'args.substrate');
	assertplus.object(args.images, 'args.images');

	substrate = args.substrate;
	assertplus.number(substrate.rs_nshards);
	assertplus.ok(substrate.rs_az_names.length > 0);
	assertplus.ok(substrate.rs_rack_names.length > 0);
	assertplus.ok(substrate.rs_server_names.length > 0);

	images = args.images;
	layout = new Layout();
	layout.ml_substrate = substrate;

	if (substrate.rs_servers_metadata === 0 ||
	    substrate.rs_servers_storage === 0) {
		layout.ml_errors.push(new VError('need at least one ' +
		    'metadata server and one storage server'));
		return (layout);
	}

	if (substrate.rs_az_names.length > 1) {
		layout.ml_errors.push(new VError('multi-datacenter ' +
		    'deployments are not yet supported by this tool'));
		return (layout);
	}

	if (substrate.rs_nshards > substrate.rs_servers_metadata) {
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
		    substrate.rs_nshards, substrate.rs_servers_metadata.length,
		    substrate.rs_servers_metadata.length == 1 ? '' : 's'));
	} else if (ML_NPERSHARD_INSTANCES * substrate.rs_nshards >
	    substrate.rs_servers_metadata) {
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
		    substrate.rs_nshards, substrate.rs_servers_metadata.length,
		    substrate.rs_servers_metadata.length == 1 ? '' : 's'));
	}

	if (substrate.rs_racks.length < 3) {
		layout.ml_warnings.push(new VError(
		    'configuration has only %d rack%s.  This configuration ' +
		    'may not surive rack failure.',
		    substrate.rs_rack_names.length,
		    substrate.rs_rack_names.length == 1 ? '' : 's'));
	} else if (substrate.rs_nshards > substrate.rs_rack_names.length) {
		layout.ml_warnings.push(new VError(
		    'requested %d shards with only %d rack%s.  ' +
		    'This configuration may not survive rack failure.',
		    substrate.rs_nshards, substrate.rs_rack_names.length,
		    substrate.rs_rack_names.length == 1 ? '' : 's'));
	}

	jsprim.forEachKey(images, function (svcname, image) {
		var count, alloc_class, cnid, i;

		if (svcname == 'nameservice' ||
		    ML_SERVICES_SINGLETON.hasOwnProperty(svcname) ||
		    ML_SERVICES_SMALL.hasOwnProperty(svcname) ||
		    ML_SERVICE_RATIOS_FRONTDOOR.hasOwnProperty(svcname)) {
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
				    (substrate.rs_servers_metadata.length /
				    ML_FRONTDOOR_NMAXINSTANCES));
				assertplus.ok(count > 0);
				assertplus.ok(count <=
				    substrate.rs_servers_metadata.length);
			}

			for (i = 0; i < count; i++) {
				cnid = layout.allocateMetadataCn(alloc_class);
				layout.allocateInstance(cnid, svcname,
				    { 'IMAGE': image });
			}
		} else {
			/* XXX */
			assertplus.ok(false, 'not yet implemented!');
		}
	});
}
