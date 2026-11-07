import io, os, pathlib, subprocess, sys, tarfile, tempfile, unittest
SCRIPT=pathlib.Path(__file__).resolve().parents[1]/'backend/scripts/scan-package.py'
class ScannerTests(unittest.TestCase):
    def call(self,path,kind):
        return subprocess.run([sys.executable,str(SCRIPT),str(path),kind],capture_output=True,text=True)
    def test_valid_portable_tar(self):
        with tempfile.TemporaryDirectory() as td:
            f=pathlib.Path(td)/'good.tar.gz'
            with tarfile.open(f,'w:gz') as out:
                obj=tarfile.TarInfo('bin/sample');obj.size=3;obj.mode=0o700
                out.addfile(obj,io.BytesIO(b'abc'))
            # scanner requires package length >=1KiB; pad gzip archive harmlessly with ignored bytes
            with open(f,'ab') as out:out.write(b'0'*1100)
            self.assertEqual(self.call(f,'tar.gz').returncode,0)
    def test_traversal_archive_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            f=pathlib.Path(td)/'bad.tar.gz'
            with tarfile.open(f,'w:gz') as out:
                obj=tarfile.TarInfo('../escape');obj.size=3
                out.addfile(obj,io.BytesIO(b'abc'))
            with open(f,'ab') as out:out.write(b'0'*1100)
            self.assertNotEqual(self.call(f,'tar.gz').returncode,0)
    def test_symlink_archive_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            f=pathlib.Path(td)/'bad.tar.gz'
            with tarfile.open(f,'w:gz') as out:
                obj=tarfile.TarInfo('link');obj.type=tarfile.SYMTYPE;obj.linkname='/etc/passwd';out.addfile(obj)
            with open(f,'ab') as out:out.write(b'0'*1100)
            self.assertNotEqual(self.call(f,'tar.gz').returncode,0)
    def test_fake_appimage_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            f=pathlib.Path(td)/'fake.AppImage';f.write_bytes(b'MZ'+b'0'*2048)
            self.assertNotEqual(self.call(f,'appimage').returncode,0)
if __name__=='__main__':unittest.main()
