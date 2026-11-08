SSH="ssh -i $HOME/.ssh/plumbline_ed25519 -o BatchMode=yes -o ConnectTimeout=10 root@108.61.70.169"
scp -i $HOME/.ssh/plumbline_ed25519 -q /tmp/relay-probe.py root@108.61.70.169:/tmp/relay-probe.py
$SSH 'docker run --rm --network plb-sbx-net --read-only --cap-drop ALL --pids-limit 64 --memory 128m -v /tmp/relay-probe.py:/probe.py:ro --entrypoint python3 plumbline-sandbox:1 /probe.py 2>&1; rm -f /tmp/relay-probe.py; echo "leftover sandbox containers: $(docker ps -a --filter name=plb-sbx- -q | wc -l)"'
