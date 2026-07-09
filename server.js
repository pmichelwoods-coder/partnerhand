// FORCE FRESH BUILD - July 9, 2026 
require('dotenv').config(); 
const express = require('express'); 
const cors = require('cors'); 
const fetch = require('node-fetch'); 
const fs = require('fs'); 
const shortid = require('shortid'); 
 
const app = express(); 
