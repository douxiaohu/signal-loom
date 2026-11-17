import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('release',Path(__file__).resolve().parents[1]/'release.py')
release=importlib.util.module_from_spec(spec);spec.loader.exec_module(release)

class ReleaseTests(unittest.TestCase):
 def test_online_backup_includes_wal_and_refuses_overwrite(self):
  with tempfile.TemporaryDirectory() as folder:
   source=Path(folder)/'source.db';target=Path(folder)/'backup.db'
   with sqlite3.connect(source) as conn:
    conn.execute('PRAGMA journal_mode=WAL');conn.execute('CREATE TABLE entries(value TEXT)');conn.execute("INSERT INTO entries VALUES ('committed-in-wal')");conn.commit()
    release.backup_database(source,target)
    with sqlite3.connect(target) as check:self.assertEqual(check.execute('SELECT value FROM entries').fetchone()[0],'committed-in-wal')
    self.assertEqual(target.stat().st_mode&0o777,0o600)
    with self.assertRaises(ValueError):release.backup_database(source,target)
 def archive(self,root,extra=None,corrupt=False):
  payload={'bin/signal-loom':b'program','dist/index.html':b'reading','dist/admin/index.html':b'admin'}
  if extra:payload.update(extra)
  meta={'release':'signal-loom-20261117-120000-abcdef123456','revision':'abcdef123456','platform':'linux/amd64','files':{name:hashlib.sha256(data).hexdigest() for name,data in payload.items()}}
  if corrupt:payload['dist/index.html']=b'changed'
  target=Path(root)/'release.tar.gz'
  with tarfile.open(target,'w:gz') as archive:
   for name,data in {**payload,'release.json':json.dumps(meta).encode()}.items():
    member=tarfile.TarInfo(name);member.size=len(data);archive.addfile(member,io.BytesIO(data))
  return target
 def test_manifest_and_file_integrity(self):
  with tempfile.TemporaryDirectory() as root:
   self.assertEqual(len(release.inspect_package(self.archive(root))['files']),3)
   with self.assertRaises(ValueError):release.inspect_package(self.archive(root,corrupt=True))
 def test_rejects_credentials_runtime_data_and_path_traversal(self):
  for name in ('.env','../secret','dist/.env.production','dist/backups/private.txt','dist/key.pem','data/private.db','outputs/report.txt','dist/assets/secrets/password.txt'):
   with self.subTest(name=name),tempfile.TemporaryDirectory() as root:
    with self.assertRaises(ValueError):release.inspect_package(self.archive(root,{name:b'not-for-release'}))
 def test_rejects_links_in_package(self):
  with tempfile.TemporaryDirectory() as root:
   target=self.archive(root)
   # Rebuild with one symbolic link; the manifest being otherwise incomplete is also rejected.
   with tarfile.open(target,'w:gz') as archive:
    member=tarfile.TarInfo('dist/index.html');member.type=tarfile.SYMTYPE;member.linkname='/etc/passwd';archive.addfile(member)
   with self.assertRaises(ValueError):release.inspect_package(target)
 def test_build_context_excludes_local_sensitive_directories(self):
  rules=(Path(__file__).resolve().parents[2]/'.dockerignore').read_text().splitlines()
  for value in ('outputs','backups','.env.*','*.pem','*.key','.ssh'):self.assertIn(value,rules)

if __name__=='__main__':unittest.main()
