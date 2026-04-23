import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (_req, res) => {
  res.send("hello from sample app");
});

app.listen(port, () => {
  console.log(`sample app listening on ${port}`);
});
