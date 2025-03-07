const express = require('express');
const app = express();
const port = 3000;

app.use((req, res, next) => {
  console.log('Request received:');
  console.log(`URL: ${req.url}`);
  console.log('Headers:');
  console.log(JSON.stringify(req.headers, null, 2));
  next();
});

app.get('/', (req, res) => {
  console.log('Root path accessed, sending 307 redirect');
  
  // Check if host is localhost:3000
  if (req.headers.host === 'localhost:3000') {
    console.log('Host is localhost:3000, redirecting');
    res.redirect(307, '/redirected');
  } else {
    console.log(`Host is ${req.headers.host}, NOT redirecting`);
    res.status(200).send(`
      <h1>No Redirect</h1>
      <p>Host header was: ${req.headers.host}</p>
      <p>Expected: localhost:3000</p>
      <pre>${JSON.stringify(req.headers, null, 2)}</pre>
    `);
  }
});

app.get('/redirected', (req, res) => {
  res.status(200).send(`
    <h1>Successfully Redirected!</h1>
    <p>This page was accessed after a 307 redirect.</p>
    <p>Host header: ${req.headers.host}</p>
    <pre>${JSON.stringify(req.headers, null, 2)}</pre>
  `);
});

app.listen(port, () => {
  console.log(`Test server listening at http://localhost:${port}`);
});
