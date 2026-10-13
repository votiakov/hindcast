#!/bin/sh
# NASA Kennedy Space Center WWW server log, July 1995 (Internet Traffic Archive, ita.ee.lbl.gov;
# freely redistributable). The archive's own host is often unreachable; this mirror is identical.
set -e
cd "$(dirname "$0")"
[ -f NASA_access_log_Jul95.gz ] || curl -fsSL -o NASA_access_log_Jul95.gz https://github.com/skakumanu/ml-bootcamp/raw/master/dataset/NASA_access_log_Jul95.gz
echo "199109ed0f273e095da6ccd5fc9dc4cd8bb58daa06d62135e62090fea9d27488  NASA_access_log_Jul95.gz" | shasum -a 256 -c -
