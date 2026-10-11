const catalog = document.getElementById('catalog');
const status = document.getElementById('libraryStatus');
const validFile = value => typeof value === 'string' && /^[a-z0-9-]+\.mp4$/.test(value);
const link = (url, title) => { const a = document.createElement('a'); a.href = url; a.textContent = title; a.target = '_blank'; a.rel = 'noopener'; return a; };
try {
  const response = await fetch('/clips/clips.json');
  if (!response.ok) throw new Error('library unavailable');
  const clips = (await response.json()).filter(c => validFile(c.file));
  for (const c of clips) {
    const card = document.createElement('article'); card.className = 'card clip';
    const category = document.createElement('span'); category.className = 'category'; category.textContent = c.category || 'Recorded video';
    const video = document.createElement('video'); video.controls = true; video.playsInline = true; video.preload = 'none'; video.src = '/clips/' + c.file;
    video.setAttribute('aria-label', `${c.title}: ${c.expect || 'recorded demo video'}`);
    if (typeof c.poster === 'string' && /^[a-z0-9-]+\.jpg$/.test(c.poster)) video.poster = '/clips/' + c.poster;
    video.addEventListener('play', () => { for (const other of catalog.querySelectorAll('video')) if (other !== video) other.pause(); });
    const title = document.createElement('h3'); title.textContent = c.title;
    const description = document.createElement('p'); description.textContent = c.expect;
    const credit = document.createElement('p'); credit.className = 'credit'; credit.textContent = c.credit;
    const more = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Source and license'; more.append(summary);
    for (const [url, name] of [[c.sourceUrl, 'Original footage'], [c.licenseUrl, 'License']]) {
      if (typeof url === 'string' && /^https:\/\//.test(url)) more.append(link(url, name), document.createTextNode(' · '));
    }
    const changes = document.createElement('p'); changes.textContent = c.changes || ''; more.append(changes);
    const analyze = document.createElement('a'); analyze.className = 'analyze'; analyze.href = '/camera.html?demo=' + encodeURIComponent(c.file); analyze.textContent = 'Use this demo →';
    card.append(category, video, title, description, credit, more, analyze); catalog.append(card);
  }
  status.textContent = `${clips.length} recorded demos · preview or stream through the model`;
} catch { status.textContent = 'Demo library could not load. Refresh once the server is connected.'; }
