# Bunnel

Bun-based secure web traffic reverse tunnel for exposing local web servers to specific remote machines (server needs bun, client does not).

For bunnel to work, the remote machine must (1) be running the bunnel-server and (2) be the only machine that accesses the tunnel.

This is not for exposing local to a public url, but rather only gives tunnel access to the machine running the tunnel server.

For example, say you have browser infrastructure running on a machine at mydomain.com. You could give this remote machine access to `localhost:3000` for its browser to access using bunnel.

See [bunnel](packages/bunnel/README.md) or [bunnel-server](pacakges/bunnel-server/README.md) for more details.
