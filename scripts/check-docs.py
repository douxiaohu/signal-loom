#!/usr/bin/env python3
"""Check maintained documentation links, anchors and embedded local images."""
from pathlib import Path
import re
import unicodedata

root=Path(__file__).resolve().parents[1]
files=[*root.glob('README*.md'),root/'SECURITY.md',root/'CONTRIBUTING.md',root/'docs/operations.md',root/'docs/architecture/current-go-runtime.md']
failures=[]
for file in files:
 text=file.read_text()
 for reference in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)',text)+re.findall(r'<img[^>]*src="([^"]+)"',text):
  if reference.startswith(('http://','https://','mailto:')):continue
  name,_,fragment=reference.partition('#');target=(file.parent/name) if name else file
  if not target.exists():failures.append(f'{file.relative_to(root)}: missing {reference}');continue
  if fragment and target.suffix=='.md':
   headings=re.findall(r'^#{1,6}\s+(.+)$',target.read_text(),re.M)
   anchors=[''.join(char for char in heading.lower().replace(' ','-') if char in '_-' or unicodedata.category(char)[0] in 'LNM') for heading in headings]
   if fragment not in anchors:failures.append(f'{file.relative_to(root)}: missing anchor {reference}')
 if text.count('<details>')!=text.count('</details>'):failures.append(f'{file.name}: unmatched details')
if failures:raise SystemExit('\n'.join(failures))
print(f'Maintained documentation links validated: {len(files)} files.')
