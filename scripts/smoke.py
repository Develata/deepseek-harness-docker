"""Disposable native Web UI smoke. Never print launch URLs, cookies or logs."""
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:3080/'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def request(opener, url):
    try:
        with opener.open(url, timeout=5) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as response:
        return response.code, response.headers, response.read()

def main():
    anonymous = urllib.request.build_opener(NoRedirect())
    token_url = None
    deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        logs = subprocess.run(['docker', 'logs', 'dsh-smoke'], capture_output=True, text=True, check=False)
        match = re.search(r'http://127\.0\.0\.1:3080/\?token=[A-Za-z0-9_-]+', logs.stdout + logs.stderr)
        if match:
            try:
                if request(anonymous, BASE)[0] == 401:
                    token_url = match.group(0)
                    break
            except (OSError, urllib.error.URLError):
                pass
        time.sleep(2)
    assert token_url is not None, 'Native authentication did not become ready'
    assert request(anonymous, BASE)[0] == 401, 'Anonymous index was not rejected'
    assert request(anonymous, BASE + '?token=invalid-smoke-token')[0] == 401, 'Invalid token was not rejected'
    assert request(anonymous, BASE + 'api/remote.mux')[0] == 401, 'Anonymous API was not rejected'
    status, headers, _ = request(anonymous, token_url)
    assert status == 303 and headers.get('Location') == './', 'Native token exchange failed'
    cookie = headers.get('Set-Cookie', '')
    assert cookie.startswith('dsh-auth-') and 'HttpOnly' in cookie, 'Expected native session cookie missing'
    authenticated = urllib.request.build_opener(NoRedirect())
    authenticated.addheaders = [('Cookie', cookie.split(';', 1)[0])]
    status, _, body = request(authenticated, BASE)
    assert status == 200 and b'<html' in body.lower(), 'Authenticated Web UI did not load'
    print('AMD64 native Web UI smoke passed: anonymous/invalid-token rejection and authenticated HTML. No model calls.')

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Exceptions/URLs/logs may contain bearer credentials. Deliberately redact.
        print('Native Web UI smoke failed. No credentials or container logs were emitted.', file=sys.stderr)
        sys.exit(1)
