"""检查普通分发构建，用固定文件顺序打包并生成可核验清单。仅依赖标准库。"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def check(source):
    manifest = json.loads((source / 'manifest.json').read_text())
    package = json.loads((ROOT / 'package.json').read_text())
    assert manifest['name'] == 'LiveTranslate', '只能打包普通分发版'
    assert manifest['version'] == package['version'], 'package 与 manifest 版本不同'
    assert f"版本 {manifest['version']}" in (source / 'popup/popup.html').read_text(), '界面版本不同'
    assert set(manifest['permissions']) == {'activeTab', 'storage', 'scripting'}, '检查基础权限变更'
    assert manifest.get('host_permissions') == ['https://chatgpt.com/*'], '仅允许 ChatGPT 无刷新恢复的固定主机权限'
    references = [manifest['background']['service_worker'], manifest['action']['default_popup'], manifest['options_ui']['page']]
    references += list(manifest['icons'].values()) + list(manifest['action']['default_icon'].values())
    for content in manifest['content_scripts']:
        references += content.get('js', []) + content.get('css', [])
    for name in references:
        assert not Path(name).is_absolute() and '..' not in Path(name).parts, '无效资源路径'
        assert (source / name).is_file(), f'资源缺失：{name}'
    expected = {
        'manifest.json', 'background/background.js', 'content/content.js', 'content/content.css',
        'popup/popup.html', 'popup/popup.js', 'setup/setup.html', 'setup/setup.js',
        'options/options.html', 'options/options.js', 'help/user-guide.html',
        'help/privacy-policy.html', 'help/support.html', 'help/site.css',
    }
    expected.update(f'icons/{prefix}{size}.png' for prefix in ['icon-', 'icon-disabled-'] for size in [16, 48, 128])
    for notice in ['LICENSE', 'THIRD_PARTY_NOTICES.md']:
        assert (ROOT / notice).is_file(), f'许可声明缺失：{notice}'
    actual = {str(item.relative_to(source)) for item in source.rglob('*') if item.is_file()}
    assert actual == expected, f'包文件白名单不符：额外 {sorted(actual-expected)}，缺失 {sorted(expected-actual)}'
    for prefix in ['icon-', 'icon-disabled-']:
        for size in [16, 48, 128]:
            data = (source / f'icons/{prefix}{size}.png').read_bytes()
            assert data[:8] == b'\x89PNG\r\n\x1a\n', '图标不是真实 PNG'
            assert struct.unpack('>II', data[16:24]) == (size, size), '图标尺寸错误'
    for name in sorted(actual):
        if name.endswith(('.js', '.json', '.html', '.css')):
            text = (source / name).read_text()
            # 检查意外的私钥块、环境配置和常见厂商密钥；不读取历史秘密做比对。
            for pattern in [r'-----BEGIN .*PRIVATE KEY-----', r'\bAKLT[A-Za-z0-9]{12,}', r'\bsk-[A-Za-z0-9]{24,}', r'VOLCENGINE_SECRET_KEY\s*[:=]\s*[\"\'][^\"\']{8,}']:
                assert not re.search(pattern, text), f'可能的凭据，请人工核对：{name}'
    return manifest, sorted(actual)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT / 'dist')
    parser.add_argument('--output', type=Path, default=ROOT / 'releases')
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    manifest, files = check(args.source.resolve())
    if args.check_only:
        print(json.dumps({'version': manifest['version'], 'files': len(files), 'checked': str(args.source.resolve())}, ensure_ascii=False))
        return
    args.output.mkdir(parents=True, exist_ok=True)
    destination = args.output / f"LiveTranslate-{manifest['version']}-source-build.zip"
    summary = {'version': manifest['version'], 'zip': str(destination.resolve()), 'files': []}
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in files + ['LICENSE', 'THIRD_PARTY_NOTICES.md']:
            data = ((ROOT if name in ['LICENSE', 'THIRD_PARTY_NOTICES.md'] else args.source) / name).read_bytes()
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
            summary['files'].append({'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    summary['bytes'] = destination.stat().st_size
    summary['sha256'] = hashlib.sha256(destination.read_bytes()).hexdigest()
    with zipfile.ZipFile(destination) as archive:
        assert archive.testzip() is None, 'ZIP 校验失败'
        assert 'manifest.json' in archive.namelist(), 'ZIP 根目录缺少 manifest'
    summary_path = destination.with_suffix('.manifest.json')
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: value for key, value in summary.items() if key != 'files'}, ensure_ascii=False))
    print(f'文件清单：{summary_path.resolve()}')


if __name__ == '__main__':
    main()
