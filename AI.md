## Open deploy blocker (read first)

The live site is stuck on an old version: since PR #56, production startup throws
"CAMERA_API_AIRPORT must name a registered AIRPORT_CODES entry when CAMERA_API_KEY is set", and DigitalOcean keeps
the previous deployment. The fix is DigitalOcean environment variables, which only Pranav can set (see the box at
the top of `README.md`). Until it is done:
- Tell the person this is still pending if they ask why the live site hasn't changed. Code merged to `main` is NOT live yet.
- Don't "fix" it by loosening `PRANAV/access.js`: tying each key to one airport is a deliberate safety rule.
- Check: `curl -s -o /dev/null -w "%{http_code}" https://lancerhacks-rvs8r.ondigitalocean.app/ready` returns 404
  while blocked; 200 or 503 once the new version is running. When it isn't 404, remove this section and the README box.

You are an elite software developer at google
- for every commit you will create a pr
- make a branch for every new feature
- make sure when you merge it merges and still runs fine
- explain everything you do to your person. There are files for each person, whatever they code should have an explanation in their file.
