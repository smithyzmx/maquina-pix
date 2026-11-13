const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); 
// Ensina o servidor a servir arquivos da pasta public
app.use(express.static('public')); 

const FIREBASE_URL = "https://maquinapelucia-222e9-default-rtdb.firebaseio.com/";

try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: FIREBASE_URL
        });
    }
    console.log("✅ Ligado ao Firebase!");
} catch (e) {
    console.log("❌ Erro na configuração: " + e.message);
}

const db = admin.database();

// ==========================================
// 📲 SISTEMA DE ALERTA NO TELEGRAM
// ==========================================
async function avisarNoTelegram(maquinaID, historyKey) {
    const token = "9088179478:AAG1PyOXEQxLjhAZPWW_7bvMenO_seNrgM0";
    const chat_id = "453736049";
    const hora = new Date().toLocaleString("pt-BR", { timeZone: "America/Recife" });

    try {
        const snapApelido = await db.ref(`/Vending-Machines/${maquinaID}/configuracoes/apelido`).once('value');
        const apelido = snapApelido.val() ? snapApelido.val() : maquinaID;

        let valorTexto = "Desconhecido";
        let statusTexto = "Expirado";
        if (historyKey) {
            const snapHistorico = await db.ref(`/Vending-Machines/${maquinaID}/historico_vendas/${historyKey}`).once('value');
            if (snapHistorico.exists()) {
                const dadosHist = snapHistorico.val();
                valorTexto = parseFloat(dadosHist.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
                statusTexto = dadosHist.status_liberacao;
            }
        }

        const texto = `🚨 *FALHA DE MÁQUINA (OFFLINE)* 🚨\n\n🕹️ *Local:* ${apelido}\n💰 *Valor:* R$ ${valorTexto}\n🔄 *Ação Tomada:* ${statusTexto}\n🕒 *Hora:* ${hora}\n\n_O PIX foi pago, mas a máquina não atracou em 60s. O sistema agiu de forma automática!_`;

        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chat_id,
            text: texto,
            parse_mode: "Markdown"
        });
        console.log(`📱 Alerta enviado com sucesso para ${apelido}`);
    } catch (err) {
        console.error("Erro ao enviar Telegram:", err.message);
    }
}

// ==========================================
// 🧠 CONFIRMAÇÃO DE DUPLA VIA & ESTORNO
// ==========================================
// Adicionámos o 'paymentId' na função para sabermos quem devemos reembolsar
async function liberarCredito(maquinaID, pulsos, historyKey = null, paymentId = null) {
    const ref = db.ref(`Vending-Machines/${maquinaID}`);
    try {
        await ref.update({
            "jogadas_pendentes": admin.database.ServerValue.increment(pulsos),
            "ultima_venda": new Date().toLocaleString("pt-BR", {timeZone: "America/Recife"})
        });
        console.log(`✅ Adicionado +${pulsos} pulsos para ${maquinaID}`);

        setTimeout(async () => {
            const snapshot = await ref.child("jogadas_pendentes").once("value");
            
            if (snapshot.val() > 0) {
                await ref.update({ "jogadas_pendentes": 0 });
                console.log(`❌ TIMEOUT: ${maquinaID} offline. Fila zerada.`);
                
                if (historyKey) {
                    let statusFinal = 'Expirado (Offline) ❌';

                    // 💸 ROTINA DE ESTORNO AUTOMÁTICO (MERCADO PAGO)
                    if (paymentId) {
                        try {
                            const chaveUnica = `${paymentId}-${Date.now()}`; // UUID exigido pela API
                            await axios.post(`https://api.mercadopago.com/v1/payments/${paymentId}/refunds`, {}, {
                                headers: {
                                    'Authorization': `Bearer ${process.env.MP_TOKEN}`,
                                    'Content-Type': 'application/json',
                                    'X-Idempotency-Key': chaveUnica
                                }
                            });
                            console.log(`💸 ESTORNO EFETUADO: O dinheiro do ID ${paymentId} foi devolvido ao cliente!`);
                            statusFinal = 'Estornado (Offline) ↩️';
                        } catch (refundError) {
                            console.error("⚠️ Falha ao tentar estornar PIX:", refundError.response?.data || refundError.message);
                            statusFinal = 'Falha no Estorno ⚠️';
                        }
                    }

                    await db.ref(`Vending-Machines/${maquinaID}/historico_vendas/${historyKey}`).update({
                        status_liberacao: statusFinal
                    });
                    
                    // Dispara o Telegram com o resultado do estorno
                    avisarNoTelegram(maquinaID, historyKey);
                }
            } else {
                if (historyKey) {
                    await db.ref(`Vending-Machines/${maquinaID}/historico_vendas/${historyKey}`).update({
                        status_liberacao: 'Consumido ✅'
                    });
                }
            }
        }, 60000); 
    } catch (error) {
        console.error("Erro ao libertar crédito:", error.message);
    }
}

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    let paymentId = null;

    if (req.query.topic === 'payment' && req.query.id) paymentId = req.query.id;
    else if (req.body.data && req.body.data.id) paymentId = req.body.data.id;
    else if (req.body.resource) paymentId = req.body.resource.split('/').pop();

    if (paymentId) {
        try {
            const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: { 'Authorization': `Bearer ${process.env.MP_TOKEN}` }
            });
            
            if (response.data.status === 'approved') {
                const valor = response.data.transaction_amount;
                let pulsosBase = Math.floor(valor); 
                
                const refExterna = response.data.external_reference || "";
                const descricao = response.data.description || "";
                const titulo = response.data.title || "";
                const posId = String(response.data.pos_id || "");

                const extrairGrua = (texto) => {
                    const regex = /GRUA-[A-Z0-9]{4}/i;
                    const match = String(texto).match(regex);
                    return match ? match[0].toUpperCase() : null;
                };
                
                const gruaEncontrada = extrairGrua(refExterna) || extrairGrua(descricao) || extrairGrua(titulo);
                let maquinaID = "Maquina-01"; 

                if (gruaEncontrada) {
                    maquinaID = gruaEncontrada; 
                } else if (posId) {
                    const vinculoSnap = await db.ref(`Vinculos-Caixas/${posId}`).once('value');
                    if (vinculoSnap.exists()) {
                        maquinaID = vinculoSnap.val();
                    }
                }

                const dataPagamento = new Date(response.data.date_approved);
                const dataAgora = new Date();
                const diferencaEmMinutos = (dataAgora - dataPagamento) / (1000 * 60);

                let pulsosFinais = pulsosBase;
                let statusInicial = "Aguardando Máquina ⏳"; 
                
                if (diferencaEmMinutos > 3) {
                    console.log(`⏳ Pagamento antigo. Guardado, NÃO libertando na ${maquinaID}.`);
                    statusInicial = "Bloqueado (Antigo)";
                }

                let tipoPagamento = 'CARTÃO';
                if (response.data.payment_method_id === 'pix' || 
                    response.data.payment_type_id === 'bank_transfer' || 
                    response.data.payment_type_id === 'account_money') {
                    tipoPagamento = 'PIX';
                }

                const historyRef = await db.ref(`Vending-Machines/${maquinaID}/historico_vendas`).push({
                    valor: valor,
                    data: Date.now(),
                    id_pagamento: paymentId,
                    metodo: tipoPagamento,
                    pos_id_recebido: posId,
                    status_liberacao: statusInicial
                });

                if (diferencaEmMinutos <= 3) {
                    const configSnap = await db.ref(`Vending-Machines/${maquinaID}/configuracoes`).once('value');
                    const conf = configSnap.val() || {};
                    const bonusValor = parseFloat(conf.bonus_valor) || 0;
                    const bonusPulsos = parseInt(conf.bonus_pulsos) || 0;

                    if (bonusValor > 0 && valor >= bonusValor) {
                        const multiplicador = Math.floor(valor / bonusValor);
                        const pulsosExtra = multiplicador * bonusPulsos;
                        pulsosFinais += pulsosExtra;
                        console.log(`🎁 BÔNUS APLICADO: +${pulsosExtra} jogadas grátis para ${maquinaID}!`);
                    }

                    // 👉 Enviamos o paymentId também, para a máquina saber o que estornar se falhar
                    liberarCredito(maquinaID, pulsosFinais, historyRef.key, paymentId);
                }
            }
        } catch (error) {
            console.error("Erro no Webhook:", error.message);
        }
    }
});

// ==========================================
// ROTAS PARA VÍNCULOS
// ==========================================
app.post('/vincular-caixa', async (req, res) => {
    const posId = req.body.pos_id;
    const maquinaId = req.body.maquina_id;
    if(posId && maquinaId) await db.ref(`Vinculos-Caixas/${posId}`).set(maquinaId.toUpperCase());
    res.redirect('/painel?aba=vinculos&status=sucesso');
});

app.post('/desvincular-caixa', async (req, res) => {
    if(req.body.pos_id) await db.ref(`Vinculos-Caixas/${req.body.pos_id}`).remove();
    res.redirect('/painel?aba=vinculos&status=sucesso');
});

// ==========================================
// GESTÃO DA PLACA
// ==========================================
app.post('/salvar-config', async (req, res) => {
    const maquina = req.body.maquina || "Maquina-01";
    await db.ref(`Vending-Machines/${maquina}/configuracoes`).update({
        "tempo_pulso_ms": parseInt(req.body.pulso) || 100,
        "tempo_pausa_ms": parseInt(req.body.pausa) || 400,
        "bonus_valor": parseFloat(req.body.bonus_valor) || 0,
        "bonus_pulsos": parseInt(req.body.bonus_pulsos) || 0
    });
    res.redirect('/painel?aba=maquinas&status=sucesso');
});

app.post('/reiniciar-maquina', async (req, res) => {
    await db.ref(`Vending-Machines/${req.body.maquina}`).update({ "comando": "REINICIAR" });
    res.redirect('/painel?aba=maquinas&status=reiniciando');
});

app.post('/deletar-maquina', async (req, res) => {
    if(req.body.maquina) await db.ref(`Vending-Machines/${req.body.maquina}`).remove();
    res.redirect('/painel?aba=maquinas&status=sucesso');
});

app.all('/webhook-manual', async (req, res) => {
    // Como é manual (Ficha Grátis), não enviamos o paymentId, logo não tem estorno de dinheiro falso.
    liberarCredito(req.query.maquina || "Maquina-01", parseInt(req.query.pulsos) || 1, null, null);
    res.send("OK");
});

app.get('/salvar-apelido', (req, res) => {
    const maquina = req.query.maquina;
    const apelido = req.query.apelido;
    
    db.ref('/Vending-Machines/' + maquina + '/configuracoes/apelido').set(apelido)
        .then(() => res.sendStatus(200))
        .catch(err => res.status(500).send(err));
});

// ==========================================
// ENTREGA DO FRONT-END
// ==========================================
app.get('/painel', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'painel.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor Online - API de Back-End Separada!"));
