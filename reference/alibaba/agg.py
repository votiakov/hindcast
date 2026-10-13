# Stream an Alibaba 2021 microservices table from stdin, aggregate per (service, minute):
#   rtqps:    calls/s served (providerRPC + HTTP MCR) summed over instances, MCR-weighted mean RT, instances serving
#   resource: CPU usage summed over samples, samples (MSResource samples every 30 s: two per container
#             per minute), memory mean
import sys, csv, collections
kind, out = sys.argv[1], sys.argv[2]
r = csv.reader(sys.stdin)
head = next(r)
idx = {h: i for i, h in enumerate(head)}
if kind == 'rtqps':
    mcr = collections.defaultdict(float); rtw = collections.defaultdict(float); inst = collections.defaultdict(set)
    # MCR and RT arrive as separate rows: pair them per (ms, inst, minute, kind)
    rt = {}
    q = {}
    it, im, ii, imet, iv = idx['timestamp'], idx['msname'], idx['msinstanceid'], idx['metric'], idx['value']
    n = 0
    for row in r:
        n += 1
        met = row[imet]
        if not (met.startswith('providerRPC') or met.startswith('HTTP')):
            continue
        key = (row[im], row[ii], int(row[it]) // 60000, met.split('_')[0])
        v = float(row[iv]) if row[iv] else 0.0
        if met.endswith('_MCR'): q[key] = q.get(key, 0.0) + v
        else: rt[key] = v
    for key, v in q.items():
        ms, ins, minute, _ = key
        k = (ms, minute)
        mcr[k] += v
        if key in rt: rtw[k] += v * rt[key]
        inst[k].add(ins)
    with open(out, 'w') as f:
        w = csv.writer(f); w.writerow(['ms', 'minute', 'rps', 'rt_ms', 'instances'])
        for k in sorted(mcr):
            w.writerow([k[0][:16], k[1], round(mcr[k], 4), round(rtw[k] / mcr[k], 3) if mcr[k] > 0 else '', len(inst[k])])
    print(kind, 'rows', n, 'keys', len(mcr), file=sys.stderr)
else:
    cpu = collections.defaultdict(float); mem = collections.defaultdict(float); inst = collections.defaultdict(int)
    it, im, ic, imem = idx['timestamp'], idx['msname'], idx['instance_cpu_usage'], idx['instance_memory_usage']
    n = 0
    for row in r:
        n += 1
        if not row[ic]: continue
        k = (row[im], int(row[it]) // 60000)
        cpu[k] += float(row[ic]); mem[k] += float(row[imem] or 0); inst[k] += 1
    with open(out, 'w') as f:
        w = csv.writer(f); w.writerow(['ms', 'minute', 'cpu', 'instances', 'mem_mean'])
        for k in sorted(cpu):
            w.writerow([k[0][:16], k[1], round(cpu[k], 4), inst[k], round(mem[k] / inst[k], 4)])
    print(kind, 'rows', n, 'keys', len(cpu), file=sys.stderr)
