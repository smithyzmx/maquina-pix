const express = require('express');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

const FIREBASE_URL = "https://maquinapelucia-222e9-default-rtdb.firebaseio.com/";

try {
    const serviceAccount = require("./firebase-key.json");
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: FIREBASE_URL
        });
    }
    console.log("✅ Conectado ao Firebase!");
} catch (e) {
    console.log("❌ Erro na chave JSON: " + e.message);
}

const db = admin.database();

app.all('/webhook-manual', async (req, res) => {
    // Se o cliente pagar R$ 2,00, enviamos 2 para o Firebase
    const qtd = parseInt(req.query.pulsos) || 2;
    console.log(`Enviando ${qtd} para jogadas_pendentes...`);

    try {
        // CAMINHO EXATO DA SUA IMAGEM: Vending-Machines -> Maquina-01 -> jogadas_pendentes
        await db.ref('Vending-Machines/Maquina-01').update({
            "jogadas_pendentes": qtd
        });
        
        console.log("✅ SUCESSO! O valor mudou no Firebase.");
        res.send(`<h1>Sucesso!</h1><p>Maquina-01 atualizada para ${qtd}.</p>`);
    } catch (error) {
        console.log("❌ ERRO: " + error.message);
        res.status(500).send("Erro: " + error.message);
    }
});

app.get('/painel', (req, res) => {
    res.send(`
        <div style="text-align:center; padding:50px; font-family:sans-serif;">
            <h1>🕹️ Painel Maquina-01</h1>
            <button onclick="location.href='/webhook-manual?pulsos=2'" style="padding:20px; font-size:20px; background:green; color:white; border-radius:10px; cursor:pointer;">
                LIBERAR 2 JOGADAS (R$ 2)
            </button>
        </div>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando!"));
