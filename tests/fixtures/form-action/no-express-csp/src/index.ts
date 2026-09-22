import express from 'express';
const app = express();
app.post('/pay', (req, res) => { res.status(200).send('ok'); });
