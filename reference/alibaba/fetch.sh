#!/bin/sh
# Alibaba cluster-trace-microservices-v2021 (github.com/alibaba/clusterdata — cite the paper if you
# publish with it): 12 hours of call rates, response times and CPU per container per minute.
# ~35 GB compressed is streamed through agg.py and never stored: what stays is ~20 MB of per-minute
# aggregates per service in <dir>.
#   sh reference/alibaba/fetch.sh <dir>
set -e
out=${1:?usage: fetch.sh <dir>}
mkdir -p "$out"
here=$(cd "$(dirname "$0")" && pwd)
B=http://aliopentrace.oss-cn-beijing.aliyuncs.com/v2021MicroservicesTraces
for i in $(seq 0 24); do [ -f "$out/rtqps_$i.csv" ] || curl -s $B/MSRTQps/MSRTQps_$i.tar.gz | tar -xzO | python3 "$here/agg.py" rtqps "$out/rtqps_$i.csv"; done
for i in $(seq 0 11); do [ -f "$out/resource_$i.csv" ] || curl -s $B/MSResource/MSResource_$i.tar.gz | tar -xzO | python3 "$here/agg.py" resource "$out/resource_$i.csv"; done
