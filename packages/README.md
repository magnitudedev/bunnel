# Bunnel Monorepo

This is a monorepo for the Bunnel project, a simple HTTP tunnel for local development.

## Packages

- [bunnel](./bunnel/README.md) - The tunnel client
- [bunnel-server](./bunnel-server/README.md) - The tunnel server

## Development

### Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/bunnel.git
cd bunnel/packages

# Install dependencies
npm install
```

### Build

```bash
# Build all packages
npm run build
```

### Clean

```bash
# Clean build artifacts
npm run clean
```

## Publishing

Each package can be published to npm independently:

```bash
# Publish client
cd bunnel
npm publish

# Publish server
cd ../bunnel-server
npm publish
```

## License

MIT
