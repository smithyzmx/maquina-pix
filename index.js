const express = require('express');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

const FIREBASE_URL = "https://maquinapelucia-222e9-default-rtdb.firebaseio.com/";

// CONFIGURAÇÃO SEGURA (Sem arquivo físico)
try {
    // Aqui ele tenta ler a variável que você colou no Render
    const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
    
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: FIREBASE_URL
        });
    }
    console.log("✅ Conectado ao Firebase via Env Var!");
} catch (e) {
    console.log("❌ Erro ao ler variável de ambiente: " + e.message);
}

const db = admin.database();
// ... resto do código (rotas de webhook e painel continuam iguais)
