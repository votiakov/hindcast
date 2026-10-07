"""
Container metrics with cAdvisor's names, read from the Docker Engine API.

cAdvisor cannot read Docker Desktop's engine on macOS, so the reference stack uses this instead.
Exposes, per running container of the reference compose projects:
  container_cpu_usage_seconds_total, container_spec_cpu_quota, container_spec_cpu_period,
  container_network_transmit_bytes_total, container_network_receive_bytes_total,
  container_memory_working_set_bytes, container_spec_memory_limit_bytes
labelled with name and container_label_com_docker_compose_service / _project, as cAdvisor does.
"""
import http.client, json, socket, threading, time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class UnixHTTP(http.client.HTTPConnection):
    def __init__(self):
        super().__init__('localhost', timeout=10)
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect('/var/run/docker.sock')

def get(path):
    c = UnixHTTP()
    c.request('GET', path)
    r = c.getresponse()
    body = r.read()
    c.close()
    return json.loads(body)

state = {'text': ''}

def one(ct):
    cid = ct['Id']
    labels = ct.get('Labels', {})
    project = labels.get('com.docker.compose.project', '')
    if project in ('bnref', ''):
        return None
    try:
        st = get(f'/containers/{cid}/stats?stream=false&one-shot=true')
        info = get(f'/containers/{cid}/json')
    except Exception:
        return None
    name = ct['Names'][0].lstrip('/')
    svc = labels.get('com.docker.compose.service', name)
    lab = f'name="{name}",container_label_com_docker_compose_service="{svc}",container_label_com_docker_compose_project="{project}"'
    cpu = st.get('cpu_stats', {}).get('cpu_usage', {}).get('total_usage', 0) / 1e9
    nets = st.get('networks') or {}
    tx = sum(n.get('tx_bytes', 0) for n in nets.values())
    rx = sum(n.get('rx_bytes', 0) for n in nets.values())
    mem = st.get('memory_stats', {})
    ws = mem.get('usage', 0) - mem.get('stats', {}).get('inactive_file', 0)
    hc = info.get('HostConfig', {})
    nano = hc.get('NanoCpus') or 0
    quota = hc.get('CpuQuota') or (nano // 10000 if nano else 0)
    period = hc.get('CpuPeriod') or (100000 if nano else 0)
    lines = [
        f'container_cpu_usage_seconds_total{{{lab},cpu="total"}} {cpu}',
        f'container_network_transmit_bytes_total{{{lab},interface="eth0"}} {tx}',
        f'container_network_receive_bytes_total{{{lab},interface="eth0"}} {rx}',
        f'container_memory_working_set_bytes{{{lab}}} {ws}',
    ]
    if quota:
        lines += [f'container_spec_cpu_quota{{{lab}}} {quota}', f'container_spec_cpu_period{{{lab}}} {period}']
    if hc.get('Memory'):
        lines.append(f'container_spec_memory_limit_bytes{{{lab}}} {hc["Memory"]}')
    return lines

def loop():
    pool = ThreadPoolExecutor(16)
    while True:
        t0 = time.time()
        try:
            cts = get('/containers/json')
            out = []
            for r in pool.map(one, cts):
                if r:
                    out += r
            state['text'] = '\n'.join(out) + '\n'
        except Exception as e:
            print('poll failed', e, flush=True)
        time.sleep(max(0.2, 2 - (time.time() - t0)))

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        b = state['text'].encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain; version=0.0.4')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def log_message(self, *a):
        pass

threading.Thread(target=loop, daemon=True).start()
ThreadingHTTPServer(('0.0.0.0', 8080), H).serve_forever()
