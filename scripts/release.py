#!/usr/bin/env python3
"""Verified artifact releases; no secrets in packages, online SQLite backups, data-safe rollback."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SAFE_EXT = {'.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.ico', '.woff', '.woff2', '.txt'}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def allowed(name):
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or any(part.startswith('.') for part in p.parts):
        return False
    return name == 'bin/signal-loom' or (len(p.parts) > 1 and p.parts[0] == 'dist' and p.suffix in SAFE_EXT and not any(part.lower() in {'outputs', 'backups', 'data', 'node_modules', 'config', 'credentials', 'secrets'} for part in p.parts))

def inspect_package(path):
    with tarfile.open(path, 'r:gz') as tar:
        members = tar.getmembers()
        names = [m.name for m in members]
        if len(names) != len(set(names)) or sum(m.size for m in members) > 300 * 1024 * 1024:
            raise ValueError('Duplicate paths or oversized release')
        if any(not m.isfile() or (m.name != 'release.json' and not allowed(m.name)) for m in members):
            raise ValueError('Release contains an unexpected path or non-regular file')
        meta = json.loads(tar.extractfile('release.json').read())
        if not re.fullmatch(r'signal-loom-[0-9]{8}-[0-9]{6}-[a-f0-9]{7,40}', meta['release']):
            raise ValueError('Invalid release identity')
        if set(meta['files']) != set(names) - {'release.json'} or 'bin/signal-loom' not in names or 'dist/index.html' not in names or 'dist/admin/index.html' not in names:
            raise ValueError('Release manifest is incomplete')
        for name, sha in meta['files'].items():
            if digest(tar.extractfile(name).read()) != sha:
                raise ValueError('Release checksum mismatch: ' + name)
        return meta

def package(args):
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT).strip():
        raise ValueError("Commit tracked and untracked source changes before packaging")
    binary = Path(args.binary)
    payload = {'bin/signal-loom': binary.read_bytes()}
    expected = {'linux/amd64': 62, 'linux/arm64': 183}[args.platform]
    if payload['bin/signal-loom'][:4] != b'\x7fELF' or int.from_bytes(payload['bin/signal-loom'][18:20], 'little') != expected:
        raise ValueError('Binary does not match the requested Linux architecture')
    dist = ROOT / 'frontend/dist'
    for file in sorted(dist.rglob('*')):
        if file.is_symlink():
            raise ValueError('Symlinks are not allowed in releases')
        if file.is_file():
            name = 'dist/' + file.relative_to(dist).as_posix()
            if not allowed(name):
                raise ValueError('Unexpected build artifact: ' + name)
            data = file.read_bytes()
            if b'-----BEGIN PRIVATE KEY-----' in data or b'-----BEGIN RSA PRIVATE KEY-----' in data:
                raise ValueError('Private key found in build artifacts')
            payload[name] = data
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    build_info = subprocess.check_output(['go', 'version', '-m', str(binary)], text=True)
    if 'vcs.revision=' + revision not in build_info or 'vcs.modified=false' not in build_info:
        raise ValueError('Build the binary from this clean Git revision before packaging')
    release = time.strftime('signal-loom-%Y%m%d-%H%M%S-') + revision[:12]
    meta = {'release': release, 'revision': revision, 'platform': args.platform, 'files': {name: digest(data) for name, data in payload.items()}}
    target = Path(args.output); target.parent.mkdir(parents=True, exist_ok=True)
    scanner = os.environ.get('GITLEAKS') or shutil.which('gitleaks') or '/tmp/signal-loom-tools/gitleaks'
    if not Path(scanner).is_file():
        raise ValueError('Install the verified scanner with scripts/install-gitleaks.sh before packaging')
    with tempfile.TemporaryDirectory(prefix='signal-loom-artifact-') as folder:
        for name, data in payload.items():
            file = Path(folder) / name; file.parent.mkdir(parents=True, exist_ok=True); file.write_bytes(data)
        scan = subprocess.run([scanner, 'dir', folder, '--config', str(ROOT / '.gitleaks.toml'), '--redact=100', '--ignore-gitleaks-allow', '--no-banner', '--report-format=json', '--report-path', str(target)+'.gitleaks.json'], capture_output=True)
        if scan.returncode != 0:
            raise ValueError('Artifact secret scan failed; inspect the local redacted report')
    with tarfile.open(target, 'w:gz') as tar:
        for name, data in {**payload, 'release.json': json.dumps(meta, sort_keys=True).encode()}.items():
            info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o755 if name.startswith('bin/') else 0o644
            tar.addfile(info, io.BytesIO(data))
    inspect_package(target)
    print(json.dumps({'release': release, 'archive': str(target), 'sha256': digest(target.read_bytes()), 'files': len(payload)}))

def strip_prefix(value, prefix):
    return value[len(prefix):] if value.startswith(prefix) else value

def mounted_database_path(source, database_url):
    if not database_url.startswith('sqlite:///'):
        raise ValueError('Only SQLite database URLs are supported')
    name = strip_prefix(database_url, 'sqlite:///')
    name = strip_prefix(name, '/app/data/') if name.startswith('/app/data/') else strip_prefix(name, './data/')
    if Path(name).is_absolute() or '..' in Path(name).parts or not name:
        raise ValueError('Database path must resolve under the persistent data mount')
    return Path(source) / name


def backup_database(source, target):
    target = Path(target)
    if target.exists():
        raise ValueError('Backup destination already exists')
    target.parent.mkdir(parents=True, exist_ok=True)
    # Online backup includes committed WAL records, never copy a live main file.
    with sqlite3.connect(Path(source).resolve().as_uri() + '?mode=ro', uri=True) as src, sqlite3.connect(target) as dst:
        src.backup(dst)
        if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Database backup failed integrity check')
    target.chmod(0o600)

def run(args, **options):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **options)
    if result.returncode:
        # Do not dump compose/inspect output: it can contain environment values.
        raise RuntimeError('Command failed: ' + ' '.join(str(arg) for arg in args[:2]))
    return result.stdout

def docker_inspect(name, image=False):
    return json.loads(run(['docker', 'image' if image else 'container', 'inspect', name]))[0]

def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2)); Path(path).chmod(0o600)

def http(port, path):
    try:
        with urllib.request.urlopen('http://127.0.0.1:' + str(port) + path, timeout=8) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()

def wait_health(container, port):
    for _ in range(60):
        try:
            state = docker_inspect(container)
            if state['State']['Running'] and http(port, '/health')[0] == 200:
                return state
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('Service did not become healthy')

def compose(app, override):
    command = ['docker', 'compose'] if subprocess.run(['docker', 'compose', 'version'], capture_output=True).returncode == 0 else ['docker-compose']
    env = os.environ.copy(); env['COMPOSE_API_VERSION'] = '1.41'
    return run(command + ['-f', str(app / 'docker-compose.yml'), '-f', str(override), 'up', '-d', '--no-build', '--force-recreate', 'telegram-forwarder'], cwd=app, env=env)

def rollback(stage):
    state = json.loads((stage / 'private-state.json').read_text())
    app = Path(state['app'])
    run(['docker', 'tag', state['rollback_image'], state['original_image_ref']])
    # Restore only the configured environment, never the database.
    compose(app, stage / 'previous-runtime.json')
    wait_health(state['container'], state['port'])
    save(stage / 'rollback-result.json', {'status': 'rolled-back', 'database_restored': False, 'release': state['release']})
    print('Rolled back image and environment; current database retained.')

def apply(args):
    os.umask(0o077)
    archive = Path(args.archive).resolve(); meta = inspect_package(archive)
    if digest(archive.read_bytes()) != args.sha256:
        raise ValueError('Uploaded archive checksum mismatch')
    stage = archive.parent; app = Path(args.app).resolve()
    old = docker_inspect(args.container)
    working_dir = old['Config']['Labels'].get('com.docker.compose.project.working_dir')
    if working_dir and Path(working_dir).resolve() != app:
        raise ValueError('Requested app directory does not match the running compose project')
    bindings = old['HostConfig'].get('PortBindings') or {}
    if not any(item.get('HostPort') == str(args.port) for values in bindings.values() for item in (values or [])):
        raise ValueError('Requested health port does not match the running container')
    if old['Config']['Labels'].get('com.docker.compose.service') != 'telegram-forwarder':
        raise ValueError('Unsupported compose service; expected telegram-forwarder')
    platform = 'linux/' + docker_inspect(old['Image'], True)['Architecture']
    if meta['platform'] != platform:
        raise ValueError('Candidate architecture does not match running image')
    backup = Path('/opt/backups/signal-loom') / meta['release']; backup.mkdir(parents=True, exist_ok=False)
    save(backup / 'container.json', old)
    for relative in ('.env', 'docker-compose.yml', 'config/groups.yaml'):
        source = app / relative
        if source.exists():
            target = backup / relative; target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(source, target); target.chmod(0o600)
    data_mount = next((m for m in old['Mounts'] if m['Destination'] == '/app/data'), None)
    if not data_mount:
        raise ValueError('Expected persistent /app/data mount')
    environment = dict(item.split('=', 1) for item in old['Config']['Env'])
    db_url = environment.get('DATABASE_URL', 'sqlite:///./data/telegram_forwarder.db')
    db = mounted_database_path(data_mount['Source'], db_url)
    backup_database(db, backup / 'database.db')
    with sqlite3.connect(db.resolve().as_uri() + '?mode=ro', uri=True) as conn:
        baseline_sources = list(conn.execute('SELECT chat_id,enabled,public_visible FROM sources ORDER BY chat_id'))
        count = conn.execute('SELECT count(*) FROM messages').fetchone()[0]
    rollback_tag = 'signal-loom-rollback:' + meta['release']
    candidate = 'signal-loom:' + meta['release']
    run(['docker', 'tag', old['Image'], rollback_tag])
    override = lambda env: {'version': '3.3', 'services': {'telegram-forwarder': {'image': old['Config']['Image'], 'environment': env}}}
    save(stage / 'previous-runtime.json', override(environment))
    next_environment = {**environment, 'PUBLIC_BASE_URL': args.public_url, 'SITE_NAME': environment.get('SITE_NAME', '拾讯')}
    save(stage / 'runtime.json', override(next_environment))
    save(stage / 'private-state.json', {'release': meta['release'], 'app': str(app), 'container': args.container, 'port': args.port, 'rollback_image': rollback_tag, 'original_image_ref': old['Config']['Image']})
    payload = stage / 'payload'; payload.mkdir()
    with tarfile.open(archive) as tar:
        # inspect_package rejected links, directories, duplicates and traversal.
        for member in tar.getmembers():
            if member.name == 'release.json': continue
            target = payload / member.name; target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(tar.extractfile(member).read()); target.chmod(0o755 if member.name.startswith('bin/') else 0o644)
    (stage / 'Dockerfile').write_text('FROM ' + rollback_tag + '\nCOPY --chown=app:app bin/signal-loom /app/telegram-radar\nCOPY --chown=app:app dist/ /app/frontend/dist/\n')
    run(['docker', 'build', '--pull=false', '--network=none', '-f', str(stage / 'Dockerfile'), '-t', candidate, str(payload)])
    uid = run(['docker','exec',args.container,'id','-u']).decode().strip()
    gid = run(['docker','exec',args.container,'id','-g']).decode().strip()
    if not uid.isdigit() or not gid.isdigit(): raise ValueError('Cannot determine runtime UID/GID')
    smoke = 'signal-loom-smoke-' + meta['revision'][:12]
    smoke_environment = {**next_environment, 'HOST': '0.0.0.0', 'PORT': '8000', 'DATABASE_URL': 'sqlite:////app/data/smoke.db', 'GROUPS_CONFIG_PATH': '/app/no-seed.yaml'}
    if any('\n' in value or '\r' in value for value in smoke_environment.values()):
        raise ValueError('Multiline environment values are not supported')
    smoke_env = stage / 'smoke.env'; smoke_env.write_text(''.join(key + '=' + value + '\n' for key, value in smoke_environment.items())); smoke_env.chmod(0o600)
    try:
        run(['docker', 'run', '-d', '--name', smoke, '--network', 'none', '--env-file', str(smoke_env), '--tmpfs', '/app/data:uid='+uid+',gid='+gid+',mode=0700', candidate])
        for _ in range(30):
            probe = subprocess.run(['docker', 'exec', smoke, 'wget', '-qO-', 'http://127.0.0.1:8000/health'], capture_output=True)
            if probe.returncode == 0: break
            time.sleep(1)
        else: raise RuntimeError('Isolated candidate failed health check')
        sources = json.loads(run(['docker', 'exec', smoke, 'wget', '-qO-', 'http://127.0.0.1:8000/api/public/sources']))
        if sources['items']: raise ValueError('Isolated candidate imported production sources')
        settings = json.loads(run(['docker', 'exec', smoke, 'wget', '-qO-', 'http://127.0.0.1:8000/api/public/config']))
        if settings['base_url'] != args.public_url: raise ValueError('Candidate site configuration mismatch')
        binary_sha = run(['docker', 'exec', smoke, 'sha256sum', '/app/telegram-radar']).decode().split()[0]
        if binary_sha != meta['files']['bin/signal-loom']: raise ValueError('Candidate binary mismatch')
    finally:
        subprocess.run(['docker', 'rm', '-f', smoke], capture_output=True)
        smoke_env.unlink(missing_ok=True)
    try:
        run(['docker', 'tag', candidate, old['Config']['Image']])
        compose(app, stage / 'runtime.json')
        current = wait_health(args.container, args.port)
        for name, sha in meta['files'].items():
            if name.startswith('dist/'):
                code, body = http(args.port, '/' + strip_prefix(name, 'dist/'))
                if code != 200 or digest(body) != sha: raise ValueError('HTTP artifact mismatch: ' + name)
        if http(args.port, '/api/admin/sources')[0] != 401: raise ValueError('Anonymous admin API was accessible')
        with sqlite3.connect(db.resolve().as_uri() + '?mode=ro', uri=True) as conn:
            if list(conn.execute('SELECT chat_id,enabled,public_visible FROM sources ORDER BY chat_id')) != baseline_sources: raise ValueError('Source permissions changed')
            if conn.execute('SELECT count(*) FROM messages').fetchone()[0] < count: raise ValueError('Message count decreased')
        mounts = lambda info: sorted((m['Source'], m['Destination'], m['RW']) for m in info['Mounts'])
        if mounts(current) != mounts(old) or current['HostConfig']['PortBindings'] != old['HostConfig']['PortBindings']: raise ValueError('Runtime mounts or ports changed')
        result = {'status': 'deployed', 'release': meta['release'], 'image': current['Image'], 'backup': str(backup), 'rollback_image': rollback_tag, 'verified_files': len(meta['files']), 'public_url': args.public_url, 'database_restored': False}
        save(stage / 'result.json', result)
        print(json.dumps(result))
    except Exception:
        rollback(stage)
        raise

def deploy(args):
    archive = Path(args.archive).resolve(); meta = inspect_package(archive)
    stage = '/opt/releases/signal-loom/' + meta['release']
    ssh = ['ssh', '-o', 'ProxyCommand=none', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', args.host]
    def remote(command, data=None):
        result = subprocess.run(ssh + [command], input=data)
        if result.returncode: raise RuntimeError('Remote release operation failed')
    q = shlex.quote
    remote("python3 -c 'import sys; assert sys.version_info >= (3, 8), \"Python 3.8+ required\"'")
    remote('umask 077; mkdir -p ' + q(stage) + '; cat > ' + q(stage + '/release.tar.gz'), archive.read_bytes())
    remote('umask 077; cat > ' + q(stage + '/release.py'), Path(__file__).read_bytes())
    command = ['python3', stage + '/release.py', '_apply', stage + '/release.tar.gz', '--sha256', digest(archive.read_bytes()), '--app', args.app, '--container', args.container, '--port', str(args.port), '--public-url', args.public_url]
    remote(shlex.join(command))
    print('Release evidence: ' + stage + '/result.json')

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__); sub = parser.add_subparsers(dest='command', required=True)
    pack = sub.add_parser('package'); pack.add_argument('--binary', required=True); pack.add_argument('--output', required=True); pack.add_argument('--platform', choices=['linux/amd64', 'linux/arm64'], default='linux/amd64')
    verify = sub.add_parser('verify-package'); verify.add_argument('archive')
    back = sub.add_parser('backup'); back.add_argument('source'); back.add_argument('target')
    for name in ('deploy', '_apply'):
        cmd = sub.add_parser(name); cmd.add_argument('archive'); cmd.add_argument('--app', default='/opt/telegram-forwarder'); cmd.add_argument('--container', default='telegram-forwarder'); cmd.add_argument('--port', type=int, default=8000); cmd.add_argument('--public-url', required=True)
        if name == 'deploy': cmd.add_argument('--host', default='racknerd-vps')
        else: cmd.add_argument('--sha256', required=True)
    roll = sub.add_parser('rollback'); roll.add_argument('stage')
    args = parser.parse_args()
    if args.command == 'package': package(args)
    elif args.command == 'verify-package': print(json.dumps({'release': inspect_package(args.archive)['release'], 'sha256': digest(Path(args.archive).read_bytes())}))
    elif args.command == 'backup': backup_database(args.source, args.target); print('Online database backup verified.')
    elif args.command == 'deploy': deploy(args)
    elif args.command == '_apply': apply(args)
    elif args.command == 'rollback': rollback(Path(args.stage))

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr); sys.exit(1)
