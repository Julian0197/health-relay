#!/usr/bin/env python3
"""Temporary HTTPS receiver for development acceptance. Never a production service.

Writes only counts, sample bounds and body hashes, not health payloads or headers.
Requires TLS and a random shared key supplied in a local, gitignored file.
"""
import argparse
import hashlib
import hmac
import json
import ssl
import threading
from collections import Counter
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--cert', required=True)
parser.add_argument('--key', required=True)
parser.add_argument('--auth-file', required=True)
parser.add_argument('--summary', required=True)
parser.add_argument('--bind', default='127.0.0.1')
parser.add_argument('--port', type=int, default=18443)
args = parser.parse_args()
auth = Path(args.auth_file).read_text().strip()
lock = threading.Lock()
batches = {}
records = set()
summaries = []

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def respond(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_POST(self):
        if not hmac.compare_digest(self.headers.get('X-Acceptance-Key', ''), auth):
            return self.respond(401, {'error': 'unauthorized'})
        if self.path not in ('/ingest', '/fail-once'):
            return self.respond(404, {'error': 'not found'})
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= 10_485_760:
            return self.respond(413, {'error': 'size'})
        body = self.rfile.read(length)
        try:
            batch = json.loads(body)
            assert batch['schemaVersion'] == 1
            assert batch['batchId'] == self.headers.get('Idempotency-Key')
            assert batch['records'] and len(batch['records']) <= 5000
            for record in batch['records']:
                assert record['op'] in ('upsert', 'delete')
                assert record['typeIdentifier'] and record['recordId']
                if record['op'] == 'upsert':
                    assert record['start'] and record['end'] and record['source']['id']
                    assert isinstance(record['payload'], dict)
        except (ValueError, KeyError, AssertionError, TypeError):
            return self.respond(422, {'error': 'invalid native batch'})
        batch_id = batch['batchId']
        digest = hashlib.sha256(body).hexdigest()
        with lock:
            previous = batches.get(batch_id)
            if previous and previous['digest'] != digest:
                return self.respond(409, {'error': 'batch body changed'})
            if self.path == '/fail-once' and not previous:
                batches[batch_id] = {'digest': digest, 'failed': True}
                self.record_summary(batch, digest, 503)
                return self.respond(503, {'error': 'synthetic first attempt failure'})
            if previous and 'receipt' in previous:
                self.record_summary(batch, digest, 200)
                return self.respond(200, previous['receipt'])
            duplicates = sum((r['typeIdentifier'], r['recordId']) in records for r in batch['records'])
            records.update((r['typeIdentifier'], r['recordId']) for r in batch['records'])
            receipt = {'batchId': batch_id, 'committed': True, 'accepted': len(batch['records']) - duplicates, 'duplicates': duplicates}
            batches[batch_id] = {'digest': digest, 'receipt': receipt}
            self.record_summary(batch, digest, 200)
            return self.respond(200, receipt)
    def record_summary(self, batch, digest, status):
        summaries.append({'receivedAt': datetime.now(timezone.utc).isoformat(), 'batchId': batch['batchId'], 'sha256': digest,
                          'status': status, 'count': len(batch['records']),
                          'types': dict(Counter(r['typeIdentifier'] for r in batch['records'])),
                          'bounds': {t: {'earliest': min(r.get('start', '') for r in batch['records'] if r['typeIdentifier'] == t),
                                         'latest': max(r.get('start', '') for r in batch['records'] if r['typeIdentifier'] == t)}
                                     for t in set(r['typeIdentifier'] for r in batch['records'])}})
        Path(args.summary).write_text(json.dumps({'requests': summaries, 'uniqueRecords': len(records)}, indent=2))

server = ThreadingHTTPServer((args.bind, args.port), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(args.cert, args.key)
server.socket = context.wrap_socket(server.socket, server_side=True)
print('Acceptance HTTPS receiver ready', flush=True)
server.serve_forever()
