#!/usr/bin/env node
/* vim: set ft=javascript: */
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * manta-adm.js: manage manta deployments.  Provides subcommands:
 *
 *     alarm		view and configure information about alarms
 *
 *     cn		show information about CNs
 *
 *     show		show information about all deployed services
 *
 *     update		given a JSON file describing the desired Manta
 *     			configuration, figure out how to get from the current
 *     			state to the desired state, and start taking those
 *     			actions
 *
 *     genconfig	generate a configuration suitable for a single-system
 *     			install on COAL or a lab machine or based on a
 *     			configuration file describing available resources
 *
 *     zk		view and manage configured nameserver instances
 *
 * NOTE: this file contains ONLY the CLI wrapper around the real functionality
 * contained in lib/adm.js.  Do NOT add deployment logic here.  It belongs in
 * the library that can eventually be consumed by other tools.
 */

var assertplus = require('assert-plus');
var bunyan = require('bunyan');
var cmdln = require('cmdln');
var cmdutil = require('cmdutil');
var jsprim = require('jsprim');
var path = require('path');
var util = require('util');
var vasync = require('vasync');
var VError = require('verror').VError;
var common = require('../lib/common');
var deploy = require('../lib/deploy');
var madm = require('../lib/adm');

var maArg0 = path.basename(process.argv[1]);

/*
 * node-cmdln interface for the manta-adm tool.
 */
function MantaAdm()
{
	cmdln.Cmdln.call(this, {
	    'name': maArg0,
	    'desc': 'Inspect and modify deployed Manta services'
	});
}

util.inherits(MantaAdm, cmdln.Cmdln);

MantaAdm.prototype.initAdm = function (opts, callback)
{
	var logstreams;

	if (opts.log_file == 'stdout') {
		logstreams = [ {
		    'level': 'debug',
		    'stream': process.stdout
		} ];
	} else if (opts.log_file) {
		logstreams = [ {
		    'level': 'debug',
		    'path': opts.log_file
		} ];
		console.error('logs at ' + opts.log_file);
	} else {
		logstreams = [ {
		    'level': process.env['LOG_LEVEL'] || 'fatal',
		    'stream': process.stderr
		} ];
	}

	this.madm_log = new bunyan({
	    'name': maArg0,
	    'streams': logstreams,
	    'serializers': bunyan.stdSerializers
	});

	this.madm_adm = new madm.MantaAdm(this.madm_log);
	this.madm_adm.loadSdcConfig(function (err) {
		if (err)
			fatal(err.message);
		callback();
	});
};

MantaAdm.prototype.finiAdm = function ()
{
	this.madm_adm.close();
};

MantaAdm.prototype.do_alarm = MantaAdmAlarm;

MantaAdm.prototype.do_cn = function (subcmd, opts, args, callback)
{
	var self = this;
	var options = {};
	var selected;

	if (opts.columns) {
		selected = checkColumns(madm.cnColumnNames(), opts.columns);
		if (selected instanceof Error) {
			callback(selected);
			return;
		}

		options.columns = selected;
	}

	if (opts.storage_only)
		options.onlystorage = true;

	if (opts.oneachnode)
		options.oneachnode = true;

	if (opts.omit_header)
		options.omitHeader = true;

	if (args.length > 0)
		options.filter = args[0];

	if (args.length > 1) {
		callback(new Error('unexpected arguments'));
		return;
	}

	this.initAdm(opts, function () {
		var adm = self.madm_adm;
		adm.fetchDeployed(function (err) {
			if (err)
				fatal(err.message);

			adm.dumpCns(process.stdout, options);
			self.finiAdm();
		});
	});
};

MantaAdm.prototype.do_cn.help =
    'Show information about Manta servers in this DC.\n\n' +
    'Usage:\n\n' +
    '    manta-adm cn OPTIONS [FILTER]\n\n' +
    'Examples:\n\n' +
    '    # list basic info about all Manta CNs in this DC\n' +
    '    manta-adm cn\n\n' +
    '    # list info about Manta CN with server uuid matching 7432ffc8\n' +
    '    manta-adm cn 7432ffc8\n\n' +
    '    # list only storage nodes\n' +
    '    manta-adm cn -s\n\n' +
    '    # list only the hostnames (and omit the header)\n' +
    '    manta-adm cn -H -o host\n\n' +
    '    # list hostnames in form suitable for "sdc-oneachnode -n"\n' +
    '    manta-adm cn -n\n\n' +
    'FILTER may be any substring of the compute node\'s server uuid, \n' +
    'admin IP, hostname, compute id, or storage ids.\n\n' +
    '{{options}}\n' +
    'Available columns for -o:\n    ' + madm.cnColumnNames().join(', ');

MantaAdm.prototype.do_cn.options = [ {
    'names': [ 'omit-header', 'H'],
    'type': 'bool',
    'help': 'Omit the header row for columnar output'
}, {
    'names': [ 'log_file', 'l' ],
    'type': 'string',
    'help': 'Dump logs to this file (or "stdout")'
}, {
    'names': [ 'oneachnode', 'n' ],
    'type': 'bool',
    'help': 'Emit output suitable for "sdc-oneachnode -n"'
}, {
    'names': [ 'columns', 'o' ],
    'type': 'arrayOfString',
    'help': 'Select columns for output (see below)'
}, {
    'names': [ 'storage-only', 's' ],
    'type': 'bool',
    'help': 'Show only nodes used as storage nodes.'
}];

MantaAdm.prototype.do_genconfig = function (subcmd, opts, args, callback)
{
	var self = this;
	var fromfile = opts.from_file;

	if (fromfile) {
		if (args.length !== 0) {
			callback(new Error('unexpected arguments'));
			return;
		}
	} else if (args.length != 1 ||
	    (args[0] != 'lab' && args[0] != 'coal')) {
		callback(new Error(
		    'expected "lab", "coal", or --from-file option'));
		return;
	} else if (opts.directory) {
		callback(new Error(
		    '--directory can only be used with --from-file'));
		return;
	}

	this.initAdm(opts, function () {
		var adm = self.madm_adm;
		var func;
		var options = {};

		if (args[0] == 'lab') {
			func = adm.dumpConfigLab;
			options['outstream'] = process.stdout;
		} else if (args[0] == 'coal') {
			func = adm.dumpConfigCoal;
			options['outstream'] = process.stdout;
		} else {
			assertplus.string(fromfile);
			func = adm.genconfigFromFile;
			options['filename'] = fromfile;
			if (opts.directory) {
				options['outDirectory'] = opts.directory;
			} else {
				options['outstream'] = process.stdout;
			}
			options['errstream'] = process.stderr;
		}

		adm.fetchDeployed(function (err) {
			if (err)
				fatal(err.message);

			func.call(adm, options, function (serr, nissues) {
				if (serr)
					fatal(serr.message);

				if (nissues !== 0) {
					console.error('error: bailing out ' +
					    'because of at least one issue');
					process.exit(1);
				}

				self.finiAdm();
			});
		});
	});
};

MantaAdm.prototype.do_genconfig.help =
    'Generate a configuration for COAL, lab, or larger deployment.\n' +
    '\n' +
    'Usage:\n' +
    '\n' +
    '    manta-adm genconfig lab\n' +
    ' or manta-adm genconfig coal\n' +
    ' or manta-adm genconfig [--directory DIR] --from-file=FILE\n';

MantaAdm.prototype.do_genconfig.options = [ {
    'names': [ 'from-file' ],
    'type': 'string',
    'helpArg': 'FILE',
    'help': 'Use server descriptions in FILE'
}, {
    'names': [ 'directory', 'd' ],
    'type': 'string',
    'helpArg': 'DIR',
    'help': 'Output directory for generated configs'
} ];

/*
 * manta-adm show: shows information about deployed services
 */
MantaAdm.prototype.do_show = function (subcmd, opts, args, callback)
{
	var self = this;
	var selected, filter;

	if ((opts.bycn || opts.all) && opts.summary) {
		callback(new Error('-c and -a cannot be used with -s'));
		return;
	}

	if (opts.json && (!opts.summary || opts.omit_header)) {
		callback(new Error('-j cannot be used without -s or with -H'));
		return;
	}

	if (opts.columns) {
		selected = checkColumns(madm.columnNames(), opts.columns);
		if (selected instanceof Error) {
			callback(selected);
			return;
		}
	}

	if (args.length > 1) {
		callback(new Error('unexpected arguments'));
		return;
	}

	if (args.length > 0)
		filter = args[0];

	this.initAdm(opts, function () {
		var adm, func;
		adm = self.madm_adm;
		if (!opts.summary) {
			if (opts.bycn)
				func = adm.dumpDeployedZonesByCn;
			else
				func = adm.dumpDeployedZonesByService;
		} else if (opts.json) {
			func = adm.dumpDeployedConfigByServiceJson;
		} else {
			func = adm.dumpDeployedConfigByService;
		}

		adm.fetchDeployed(function (err) {
			if (err)
				fatal(err.message);

			func.call(adm, process.stdout, {
			    'doall': opts.all,
			    'omitHeader': opts.omit_header,
			    'filter': filter,
			    'columns': opts.columns ? selected : null
			});
			self.finiAdm();
		});
	});
};

MantaAdm.prototype.do_show.help =
    'Show information about deployed services.\n\n' +
    'Usage:\n\n' +
    '    manta-adm show OPTIONS [SERVICE]\n\n' +
    'Examples:\n\n' +
    '    # list all Manta zones in the current DC\n' +
    '    manta-adm show\n\n' +
    '    # list zones in the current DC by compute node\n' +
    '    manta-adm show -c\n\n' +
    '    # summarize Manta zones in the current DC\n' +
    '    manta-adm show -s\n\n' +
    '    # list all Manta zones in all datacenters (no IP info available)\n' +
    '    manta-adm show -a\n\n' +
    '    # show only postgres zones in the current datacenter\n' +
    '    manta-adm show postgres\n\n' +
    '{{options}}\n' +
    'Available columns for -o:\n    ' + madm.columnNames().join(', ');

MantaAdm.prototype.do_show.options = [ {
    'names': [ 'all', 'a' ],
    'type': 'bool',
    'help': 'Show results from all datacenters, rather than just the local one'
}, {
    'names': [ 'bycn', 'c' ],
    'type': 'bool',
    'help': 'Show results by compute node, rather than by service.'
}, {
    'names': [ 'omit-header', 'H'],
    'type': 'bool',
    'help': 'Omit the header row for columnar output'
}, {
    'names': [ 'json', 'j' ],
    'type': 'bool',
    'help': 'Show results in JSON form suitable for importing with "update".'
}, {
    'names': [ 'log_file', 'l' ],
    'type': 'string',
    'help': 'dump logs to this file (or "stdout")'
}, {
    'names': [ 'columns', 'o' ],
    'type': 'arrayOfString',
    'help': 'Select columns for output (see below)'
}, {
    'names': [ 'summary', 's' ],
    'type': 'bool',
    'help': 'Show summary of deployed zones rather than each zone separately.'
} ];

/*
 * manta-adm update: deploys, undeploys, and redeploys to match a desired
 * deployment specification
 */
MantaAdm.prototype.do_update = function (subcmd, opts, args, callback)
{
	var filename, service, nchanges, adm;
	var self = this;

	if (args.length === 0) {
		callback(new Error(
		    'expected filename for desired configuration'));
		return;
	}

	if (args.length > 2) {
		callback(new Error('unexpected arguments'));
		return;
	}

	filename = args[0];
	if (args.length == 2)
		service = args[1];

	vasync.pipeline({
	    'funcs': [
		function initAdm(_, stepcb) {
			self.initAdm(opts, function () {
				adm = self.madm_adm;
				stepcb();
			});
		},
		function readConfig(_, stepcb) {
			adm.readConfigFromFile(filename, stepcb);
		},
		function fetchDeployed(_, stepcb) {
			adm.fetchDeployed(stepcb);
		},
		function generatePlan(_, stepcb) {
			adm.generatePlan(stepcb, service, opts.no_reprovision);
		},
		function dumpPlan(_, stepcb) {
			adm.execPlan(process.stdout, process.stderr,
			    true, function (err, count) {
				if (err) {
					stepcb(err);
					return;
				}

				nchanges = count;
				if (count > 0 && opts.dryrun)
					console.log('To apply these changes, ' +
					    'leave off -n (--dry-run).');

				stepcb();
			    });
		},
		function uconfirm(_, stepcb) {
			if (opts.dryrun || nchanges === 0 || opts.confirm) {
				stepcb();
				return;
			}

			common.confirm(
			    'Are you sure you want to proceed? (y/N): ',
			    function (proceed) {
				process.stdout.write('\n');
				if (!proceed) {
					stepcb(new Error('aborted by user'));
				} else {
					stepcb();
				}
			    });
		},
		function execPlan(_, stepcb) {
			if (opts.dryrun || nchanges === 0) {
				stepcb();
				return;
			}

			adm.execPlan(process.stdout, process.stderr,
			    false, stepcb);
		}
	    ]
	}, function (err) {
		if (err)
			fatal(err.message);
		self.finiAdm();
		callback();
	});
};

MantaAdm.prototype.do_update.help =
    'Update deployment to match a JSON configuration.\n\n{{options}}';

MantaAdm.prototype.do_update.options = [ {
    'names': [ 'log_file', 'l' ],
    'type': 'string',
    'help': 'dump logs to this file (or "stdout")',
    'default': '/var/log/manta-adm.log'
}, {
    'names': [ 'dryrun', 'n' ],
    'type': 'bool',
    'help': 'Print what would be done without actually doing it.'
}, {
    'names': [ 'confirm', 'y' ],
    'type': 'bool',
    'help': 'Bypass all confirmations (be careful!)'
}, {
    'names': [ 'no-reprovision' ],
    'type': 'bool',
    'help': 'When upgrading a zone, always provision and deprovision ' +
	'rather than reprovision'
} ];

MantaAdm.prototype.do_zk = MantaAdmZk;

function MantaAdmZk(parent)
{
	this.mn_parent = parent;
	cmdln.Cmdln.call(this, {
	    'name': 'zk',
	    'desc': 'View and modify ZooKeeper servers configuration.'
	});
}

util.inherits(MantaAdmZk, cmdln.Cmdln);

MantaAdmZk.prototype.do_list = function (subcmd, opts, args, callback)
{
	var self = this;
	var options = {};
	var selected;

	if (args.length > 0) {
		callback(new Error('unexpected arguments'));
		return;
	}

	if (opts.columns) {
		selected = checkColumns(madm.zkColumnNames(), opts.columns);
		if (selected instanceof Error) {
			callback(selected);
			return;
		}

		options.columns = selected;
	}

	if (opts.omit_header)
		options.omitHeader = true;

	this.mn_parent.initAdm(opts, function () {
		var adm = self.mn_parent.madm_adm;
		adm.fetchDeployed(function (err) {
			var problems;

			if (err)
				fatal(err.message);
			problems = adm.dumpZkServers(process.stdout, options);
			problems.critical.forEach(function (warn) {
				console.error('error: %s', warn.message);
			});
			problems.fixable.forEach(function (warn) {
				console.error('warning: %s', warn.message);
			});

			if (problems.critical.length +
			    problems.fixable.length > 0)
				process.exit(1);
			self.mn_parent.finiAdm();
		});
	});
};

MantaAdmZk.prototype.do_list.help =
    'List configured ZooKeeper servers\n\n' +
    'Usage:\n\n' +
    '    manta-adm zk list OPTIONS\n\n' +
    'Examples:\n\n' +
    '    # list ZooKeeper servers\n' +
    '    manta-adm zk list\n\n' +
    '    # list only IPs of ZK servers\n' +
    '    manta-adm zk list --omit-header -o ip\n\n' +
    '{{options}}\n' +
    'Available columns for -o:\n    ' + madm.zkColumnNames().join(', ');

/*
 * Note that the "manta-adm" commands that may modify the system use
 * /var/log/manta-adm.log as the default log file, as those logs currently serve
 * as general debug logs.  But the "zk list" subcommand is read-only and only
 * applicable to this user, so we use a path in /var/tmp for the log.
 */
MantaAdmZk.prototype.do_list.options = [ {
    'names': [ 'omit-header', 'H'],
    'type': 'bool',
    'help': 'Omit the header row for columnar output'
}, {
    'names': [ 'log_file', 'l' ],
    'type': 'string',
    'help': 'dump logs to this file (or "stdout")',
    'default': '/var/tmp/manta-adm.log'
}, {
    'names': [ 'columns', 'o' ],
    'type': 'arrayOfString',
    'help': 'Select columns for output (see below)'
} ];

MantaAdmZk.prototype.do_fixup = function (subcmd, opts, args, callback)
{
	var self = this;
	var adm, nissues, nfixed;

	if (args.length > 0) {
		callback(new Error('unexpected arguments'));
		return;
	}

	vasync.pipeline({
	    'funcs': [
		function initAdm(_, stepcb) {
			self.mn_parent.initAdm(opts, function () {
				adm = self.mn_parent.madm_adm;
				stepcb();
			});
		},
		function fetchDeployed(_, stepcb) {
			adm.fetchDeployed(stepcb);
		},
		function dumpNameservers(_, stepcb) {
			var problems;

			console.error('CURRENT CONFIGURATION');
			problems = adm.dumpZkServers(process.stderr, {});
			if (problems.critical.length > 0) {
				problems.critical.forEach(function (e) {
					console.error('error: %s', e.message);
				});
				stepcb(new VError('bailing out after errors'));
				return;
			}

			nissues = problems.fixable.length;
			if (nissues === 0) {
				console.error('no issues to repair');
				stepcb();
				return;
			}

			console.error(
			    'The following issues should be repaired:');
			problems.fixable.forEach(function (e) {
				console.error('error: %s', e.message);
			});

			if (opts.dryrun) {
				console.error('To repair, leave off ' +
				    '-n (--dry-run)');
			}

			stepcb();
		},
		function uconfirm(_, stepcb) {
			if (opts.dryrun || nissues === 0 || opts.confirm) {
				stepcb();
				return;
			}

			common.confirm(
			    'Do you want to repair these issues now? (y/N): ',
			    function (proceed) {
				process.stdout.write('\n');
				if (!proceed) {
					stepcb(new Error('aborted by user'));
				} else {
					stepcb();
				}
			    });
		},
		function repair(_, stepcb) {
			if (opts.dryrun || nissues === 0) {
				stepcb();
				return;
			}

			adm.fixupZkServers(function (err, n) {
				if (!err)
					nfixed = n;
				stepcb(err);
			});
		}
	    ]
	}, function (err) {
		if (err)
			fatal(err.message);
		if (!opts.dryrun && nissues > 0)
			console.error('%d issue%s repaired',
			    nfixed, nfixed == 1 ? '' : 's');
		self.mn_parent.finiAdm();
		callback();
	});
};

MantaAdmZk.prototype.do_fixup.help = [
    'Repair ZooKeeper configuration',
    '',
    'This command compares the ZooKeeper configuration (defined by the ',
    'ZK_SERVERS and ZK_ID SAPI metadata properties) to the list of deployed ',
    'nameservice zones, reports any discrepancies or other issues, and ',
    'optionally repairs certain kinds of issues.  If repairs are made, only ',
    'metadata is changed.  This tool is intended for cases where a ZK server ',
    'has been undeployed and the configuration needs to be updated, or where ',
    'deployment failed and left stale configuration, or other unusual cases ',
    'where the configuration does not match the list of deployed nameservers.',
    'The "manta-adm zk list" command identifies these problem cases.',
    '',
    'Usage:',
    '',
    '    manta-adm zk [-n | --dry-run] [-y | --confirm] fixup',
    '',
    'Examples:',
    '',
    '    # check for configuration issues and repair them',
    '    manta-adm zk fixup',
    '',
    '{{options}}'
].join('\n');

MantaAdmZk.prototype.do_fixup.options = [ {
    'names': [ 'confirm', 'y' ],
    'type': 'bool',
    'help': 'Bypass all confirmations (be careful!)'
}, {
    'names': [ 'dryrun', 'n' ],
    'type': 'bool',
    'help': 'Print what would be done without actually doing it.'
}, {
    'names': [ 'log_file', 'l' ],
    'type': 'string',
    'help': 'Dump logs to this file (or "stdout")'
} ];

function MantaAdmAlarm(parent)
{
	this.maa_parent = parent;
	cmdln.Cmdln.call(this, {
	    'name': 'alarm',
	    'desc': 'View and configure information about alarms.'
	});
}

util.inherits(MantaAdmAlarm, cmdln.Cmdln);

MantaAdmAlarm.prototype.initAdmAndFetchAlarms = function (opts, callback)
{
	vasync.pipeline({
	    'arg': this,
	    'funcs': [
		function initAdm(self, stepcb) {
			self.maa_parent.initAdm(opts, stepcb);
		},
		function fetch(self, stepcb) {
			self.maa_parent.madm_adm.fetchDeployed(stepcb);
		},
		function fetchAmon(self, stepcb) {
			self.maa_parent.madm_adm.alarmsInit(stepcb);
		}
	    ]
	}, function (err) {
		if (err) {
			fatal(err.message);
		}

		callback();
	});
};

MantaAdmAlarm.prototype.do_close = function (subcmd, opts, args, callback)
{
	var parent;

	if (args.length < 1) {
		callback(new Error('expected ALARMID'));
		return;
	}

	parent = this.maa_parent;
	this.initAdmAndFetchAlarms(opts, function () {
		var adm = parent.madm_adm;
		adm.alarmsClose({
		    'alarmIds': args,
		    'concurrency': opts.concurrency
		}, function (err, errors) {
		    errors.forEach(function (e) {
			console.error('error: %s', e.message);
		    });

		    if (errors.length > 0) {
			process.exit(1);
		    }

		    parent.finiAdm();
		});
	});
};

MantaAdmAlarm.prototype.do_close.help = [
    'Close open alarms',
    '',
    'Usage:',
    '',
    '    manta-adm alarm close ALARMID...',
    '',
    '{{options}}'
].join('\n');

MantaAdmAlarm.prototype.do_close.options = [ {
    'names': [ 'concurrency' ],
    'type': 'positiveInteger',
    'help': 'Number of concurrent requests to make',
    'default': 10
} ];

MantaAdmAlarm.prototype.do_config = MantaAdmAlarmConfig;

MantaAdmAlarm.prototype.do_details = function (subcmd, opts, args, callback)
{
	var self = this;

	if (args.length < 1) {
		callback(new Error('expected ALARMID'));
		return;
	}

	/*
	 * XXX We should be able to fetch details about closed alarms.  This
	 * currently only looks up information in the *open* alarms that we've
	 * already fetched.
	 */
	this.initAdmAndFetchAlarms(opts, function () {
		var nerrors = 0;
		args.forEach(function (id) {
			var error;
			error = self.maa_parent.madm_adm.alarmPrint({
			    'id': id,
			    'stream': process.stdout,
			    'nmaxfaults': 1
			});

			if (error instanceof Error) {
				console.error('warn: %s', error.message);
			}

			console.log('');
		});

		if (nerrors > 0) {
			process.exit(1);
		}
		self.maa_parent.finiAdm();
	});
};

MantaAdmAlarm.prototype.do_details.help = [
    'Print details about an alarm',
    '',
    'Usage:',
    '',
    '    manta-adm alarm details ALARMID...',
    '',
    '{{options}}'
].join('\n');

MantaAdmAlarm.prototype.do_details.options = [];

MantaAdmAlarm.prototype.do_faults = function (subcmd, opts, args, callback)
{
	var self = this;

	if (args.length < 1) {
		callback(new Error('expected ALARMID'));
		return;
	}

	/*
	 * XXX We should be able to fetch details about closed alarms.  This
	 * currently only looks up information in the *open* alarms that we've
	 * already fetched.
	 * XXX This also duplicates code from "details"
	 */
	this.initAdmAndFetchAlarms(opts, function () {
		var nerrors = 0;
		args.forEach(function (id) {
			var error;
			error = self.maa_parent.madm_adm.alarmPrint({
			    'id': id,
			    'stream': process.stdout
			});

			if (error instanceof Error) {
				console.error('warn: %s', error.message);
			}

			console.log('');
		});

		if (nerrors > 0) {
			process.exit(1);
		}
		self.maa_parent.finiAdm();
	});
};

MantaAdmAlarm.prototype.do_faults.help = [
    'Print information about all of an alarm\'s faults',
    '',
    'Usage:',
    '',
    '    manta-adm alarm fault ALARMID...',
    '',
    '{{options}}'
].join('\n');

MantaAdmAlarm.prototype.do_faults.options = [];

MantaAdmAlarm.prototype.do_ka = function (subcmd, opts, args, callback)
{
	var self = this;

	if (args.length < 1) {
		callback(new Error('expected EVENT_NAME'));
		return;
	}

	this.initAdmAndFetchAlarms(opts, function () {
		var nerrors = 0;
		args.forEach(function (eventName) {
			var error;
			error = self.maa_parent.madm_adm.alarmKaPrint({
			    'eventName': eventName,
			    'stream': process.stdout
			});

			if (error instanceof Error) {
				console.error('warn: %s', error.message);
			}

			console.log('');
		});

		if (nerrors > 0) {
			process.exit(1);
		}
		self.maa_parent.finiAdm();
	});
};

MantaAdmAlarm.prototype.do_ka.help = [
    'Print information about a possible fault',
    '',
    'Usage:',
    '',
    '    manta-adm alarm ka EVENT_NAME',
    '',
    '{{options}}'
].join('\n');

MantaAdmAlarm.prototype.do_ka.options = [];

MantaAdmAlarm.prototype.do_list = function (subcmd, opts, args, callback)
{
	var self = this;
	var options = {};

	if (args.length > 0) {
		callback(new Error('unexpected arguments'));
		return;
	}

	options = listPrepareArgs(opts, madm.alarmColumnNames());
	if (options instanceof Error) {
		callback(options);
		return;
	}

	options.stream = process.stdout;
	this.initAdmAndFetchAlarms(opts, function () {
		self.maa_parent.madm_adm.alarmsList(options);
		self.maa_parent.finiAdm();
		callback();
	});
};

MantaAdmAlarm.prototype.do_list.help = [
    'List open alarms',
    '',
    'Usage:',
    '',
    '    manta-adm alarm list OPTIONS',
    '',
    '{{options}}',
    '',
    'Available columns for -o:\n    ' + madm.alarmColumnNames().join(', ')
].join('\n');

MantaAdmAlarm.prototype.do_list.options = [ {
    'names': [ 'omit-header', 'H'],
    'type': 'bool',
    'help': 'Omit the header row for columnar output'
}, {
    'names': [ 'columns', 'o' ],
    'type': 'arrayOfString',
    'help': 'Select columns for output (see below)'
} ];


function MantaAdmAlarmConfig(parent)
{
	this.maac_parent = parent;
	this.maac_root = parent.maa_parent;

	cmdln.Cmdln.call(this, {
	    'name': 'config',
	    'desc': 'Manage probe and probe group configuration'
	});
}

util.inherits(MantaAdmAlarmConfig, cmdln.Cmdln);

MantaAdmAlarmConfig.prototype.do_probegroups = MantaAdmAlarmProbeGroup;

MantaAdmAlarmConfig.prototype.do_update =
    function (subcmd, opts, args, callback)
{
	if (args.length > 0) {
		callback(new Error('unexpected arguments'));
		return;
	}

	this.amonUpdateSubcommand(opts, opts.dryrun, callback);
};

MantaAdmAlarmConfig.prototype.do_update.help = [
    'Update and probes and probe groups that are out of date.',
    '',
    'Usage:',
    '',
    '    manta-adm alarm config update OPTIONS',
    '    manta-adm alarm config update OPTIONS --unconfigure',
    '',
    '{{options}}'
].join('\n');

MantaAdmAlarmConfig.prototype.do_update.options = [ {
    'names': [ 'confirm', 'y' ],
    'type': 'bool',
    'help': 'Bypass all confirmations (be careful!)'
}, {
    'names': [ 'concurrency' ],
    'type': 'positiveInteger',
    'help': 'Number of concurrency requests to make',
    'default': 10
}, {
    'names': [ 'dryrun', 'n' ],
    'type': 'bool',
    'help': 'Print what would be done without actually doing it.'
}, {
    'names': [ 'unconfigure' ],
    'type': 'bool',
    'help': 'Remove all probes and probe groups instead of updating them',
    'default': false
} ];

MantaAdmAlarmConfig.prototype.do_verify =
    function (subcmd, opts, args, callback)
{
	if (args.length > 0) {
		callback(new Error('unexpected arguments'));
		return;
	}

	this.amonUpdateSubcommand(opts, true, callback);
};

MantaAdmAlarmConfig.prototype.do_verify.help = [
    'Check that configured probes and probe groups are up to date.',
    '',
    'Usage:',
    '',
    '    manta-adm alarm config verify OPTIONS',
    '',
    '{{options}}'
].join('\n');

MantaAdmAlarmConfig.prototype.do_verify.options = [ {
    'names': [ 'concurrency' ],
    'type': 'positiveInteger',
    'help': 'Number of concurrent requests to make',
    'default': 10
}, {
    'names': [ 'unconfigure' ],
    'type': 'bool',
    'help': 'Remove all probes and probe groups instead of updating them',
    'default': false
} ];

MantaAdmAlarmConfig.prototype.amonUpdateSubcommand =
    function (clioptions, dryrun, callback) {
	var self = this;
	var root, parent, adm, plan;

	assertplus.object(clioptions, 'clioptions');
	assertplus.number(clioptions.concurrency, 'clioptions.concurrency');
	assertplus.bool(clioptions.unconfigure, 'clioptions.unconfigure');

	root = self.maac_root;
	parent = self.maac_parent;
	vasync.pipeline({
	    'arg': null,
	    'funcs': [
		function init(_, stepcb) {
			parent.initAdmAndFetchAlarms(clioptions, stepcb);
		},
		function fetchProbes(_, stepcb) {
			adm = root.madm_adm;
			adm.alarmsInitProbes({
			    'concurrency': clioptions.concurrency
			}, stepcb);
		},
		function generateAmonPlan(_, stepcb) {
			var options = {
				unconfigure: clioptions.unconfigure
			};
			plan = adm.amonUpdatePlanCreate(options);
			if (plan instanceof Error) {
				stepcb(plan);
				return;
			}

			adm.amonUpdatePlanDump({
			    'plan': plan,
			    'stream': process.stderr,
			    'verbose': false
			});

			if (!plan.needsChanges()) {
				console.log('nothing to do');
				stepcb();
				return;
			}

			if (dryrun) {
				console.log('To apply these changes, ' +
				    'use the "update" subcommand without ' +
				    'the -n/--dry-run option.');
				stepcb();
				return;
			}

			if (clioptions.confirm) {
				stepcb();
				return;
			}

			common.confirm(
			    'Are you sure you want to proceed? (y/N): ',
			    function (proceed) {
				if (!proceed) {
					stepcb(new Error('aborted by user'));
				} else {
					stepcb();
				}
			    });
		},
		function execAmonPlan(_, stepcb) {
			if (dryrun || !plan.needsChanges()) {
				stepcb();
				return;
			}

			adm.amonUpdatePlanApply({
			    'concurrency': clioptions.concurrency,
			    'plan': plan
			}, stepcb);
		}
	    ]
	}, function (err) {
		root.finiAdm();
		callback(err);
	});
};


function MantaAdmAlarmProbeGroup(parent)
{
	this.maap_parent = parent;
	this.maap_root = parent.maac_root;

	cmdln.Cmdln.call(this, {
	    'name': 'probegroup',
	    'desc': 'View and configure information about amon probe groups.'
	});
}

util.inherits(MantaAdmAlarmProbeGroup, cmdln.Cmdln);

MantaAdmAlarmProbeGroup.prototype.do_list = function (subcmd,
    opts, args, callback)
{
	var self = this;
	var options = {};

	if (args.length > 0) {
		callback(new Error('unexpected arguments'));
		return;
	}

	options = listPrepareArgs(opts, madm.probeGroupColumnNames());
	if (options instanceof Error) {
		callback(options);
		return;
	}

	options.stream = process.stdout;
	this.maap_parent.maac_parent.initAdmAndFetchAlarms(opts, function () {
		self.maap_root.madm_adm.alarmsProbeGroupsList(options);
		self.maap_root.finiAdm();
		callback();
	});
};

MantaAdmAlarmProbeGroup.prototype.do_list.help = [
    'List open alarms',
    '',
    'Usage:',
    '',
    '    manta-adm alarm probegroup list OPTIONS',
    '',
    '{{options}}',
    '',
    'Available columns for -o:\n',
    '    ' + madm.probeGroupColumnNames().join(', ')
].join('\n');

MantaAdmAlarmProbeGroup.prototype.do_list.options = [ {
    'names': [ 'omit-header', 'H'],
    'type': 'bool',
    'help': 'Omit the header row for columnar output'
}, {
    'names': [ 'columns', 'o' ],
    'type': 'arrayOfString',
    'help': 'Select columns for output (see below)'
} ];


/*
 * Named arguments:
 *
 *     opts		options provided by cmdln
 *
 *     allowed		allowed column names
 *
 * Returns either an Error describing invalid command-line arguments or an
 * object with "columns" and "omitHeader" set according to the options.
 * XXX abstract other uses of checkColumns to use this
 */
function listPrepareArgs(opts, allowed)
{
	var options, selected;

	options = {};
	if (opts.columns) {
		selected = checkColumns(allowed, opts.columns);
		if (selected instanceof Error) {
			return (selected);
		}

		options.columns = selected;
	}

	if (opts.omit_header) {
		options.omitHeader = true;
	} else {
		options.omitHeader = false;
	}

	return (options);
}

function checkColumns(allowed, columns)
{
	var selected, c, i;

	selected = [];
	for (i = 0; i < columns.length; i++) {
		c = columns[i].split(',');
		selected = selected.concat(columns[i].split(','));
	}

	for (i = 0; i < selected.length; i++) {
		c = selected[i];
		if (allowed.indexOf(c) == -1)
			return (new VError('unknown column: "%s"', c));
	}

	return (selected);
}

function fatal(msg)
{
	console.error('%s: %s', maArg0, msg);
	process.exit(1);
}

cmdutil.exitOnEpipe();
cmdln.main(MantaAdm);
