// index.js
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import 'bootstrap/dist/css/bootstrap.min.css'; // <-- import bootstrap CSS once globally
import './App.css'; // optional global import (you can also import inside component)

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
