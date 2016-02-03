# MANTA-ADM 1 "2016" Manta "Manta Operator Commands"

## NAME

manta-adm - administer a Manta deployment

## SYNOPSIS

`manta-adm cn [-l LOG_FILE] [-H] [-o FIELD...] [-n] [-s] CN_FILTER`

`manta-adm genconfig "lab" | "coal"`

`manta-adm show [-l LOG_FILE] [-a] [-c] [-H] [-o FIELD...] [-s] FILTER`

`manta-adm show [-l LOG_FILE] [-js] FILTER`

`manta-adm update [-l LOG_FILE] [-n] [-y] [--no-reprovision] FILTER`

`manta-adm zk list [-l LOG_FILE] [-H] [-o FIELD...]`

`manta-adm zk fixup [-l LOG_FILE] [-n] [-y]`


## DESCRIPTION

The `manta-adm` command is used to administer various aspects of a Manta
deployment.  This command only operates on zones within the same datacenter.
The command may need to be repeated in other datacenters in order to execute it
across an entire Manta deployment.

`manta-adm cn`
  Show information about Manta servers in this DC.

`manta-adm genconfig`
  Generate a configuration for a COAL or lab deployment.

`manta-adm show`
  Show information about deployed services.

`manta-adm update`
  Update deployment to match a JSON configuration.

`manta-adm zk`
  View and modify ZooKeeper servers configuration.

Many subcommands produce tabular output, with a header row, one data record per
line, and columns separated by whitespace.  With any of these commands, you can
use options:

`-H, --omit-header`
  Do not print the header row.

`-o, --columns FIELD[,FIELD...]`
  Only print columns named `FIELD`.  You can specify this option multiple times
  or use comma-separated field names (or both) to select multiple fields.  The
  available field names vary by command and are described in the corresponding
  command section above.

Many commands also accept:

`-l, --log_file LOGFILE`
  Emit verbose log to LOGFILE.  The special string "stdout" causes output to be
  emitted to the program's stdout.


### "cn" subcommand

`manta-adm cn [-l LOG_FILE] [-H] [-o FIELD...] [-n] [-s] [CN_FILTER]`

The `manta-adm cn` subcommand is used to list SDC compute nodes being used in
the current Manta deployment in the current datacenter.  The default output is a
table with one row per compute node.  See above for information on the `-l`,
`-H`, and `-o` options.

`-n, --oneachnode`
  Instead of printing a table, emit a comma-separated list of matching
  hostnames, suitable for use with sdc-oneachnode(1)'s `-n` option.  See also
  manta-oneach(1).

`-s, --storage-only`
  Show only compute nodes with "storage" zones on them.

The optional `CN_FILTER` string can be used to provide any substring of a
compute node's hostname, server uuid, administrative IP address, compute id, or
storage ids.  All matching compute nodes will be reported.

Available fields for the `-o/--columns` option include "server\_uuid", "host",
"dc" (the datacenter name), "admin\_ip", "ram", "compute\_id", "storage\_ids",
and "kind" (which is either "storage" or "other").

Example: list basic info about all Manta CNs in this DC:

    # manta-adm cn

Example: list info about Manta CN with server uuid matching 7432ffc8:

    # manta-adm cn 7432ffc8

Example: list only storage nodes:

    # manta-adm cn -s

Example: list only the hostnames (and omit the header):

    # manta-adm cn -H -o host

Example: list hostnames in form suitable for "sdc-oneachnode -n":

    # manta-adm cn -n


## EXIT STATUS

`0`
  Success

`1`
  Generic failure.

`2`
  The command-line options were not valid.


## COPYRIGHT

Copyright (c) 2016 Joyent Inc.

## SEE ALSO

json(1), Manta Operator's Guide
