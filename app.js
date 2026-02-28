require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin'); 
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai'); // We keep this package, but point it to Groq!
const serviceAccount = require("./key.json"); 

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
// Safely check for either GROQ_API_KEY or OPENAI_API_KEY
const API_KEY = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY; 
if (!API_KEY) {
    console.error("ERROR: API Key is missing in .env file");
}

// Point to Groq's FREE servers instead of OpenAI's paid servers
const openai = new OpenAI({ 
    apiKey: API_KEY,
    baseURL: "https://api.groq.com/openai/v1" 
});

// Middleware
app.set('view engine', 'ejs');
app.use(cors());
app.use(express.static('public'));
app.use(express.json({ limit: '50mb' })); 
app.use(bodyParser.urlencoded({ extended: true }));

// --- FIREBASE INITIALIZATION ---
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// --- AI QUEUE SYSTEM (Prevents 429 Errors) ---
let apiCallQueue = [];
let isProcessing = false;

async function executeWithQueue(taskFn) {
    return new Promise((resolve, reject) => {
        apiCallQueue.push({ taskFn, resolve, reject });
        processQueue();
    });
}

async function processQueue() {
    if (isProcessing || apiCallQueue.length === 0) return;
    isProcessing = true;
    const { taskFn, resolve, reject } = apiCallQueue.shift();
    try {
        const result = await taskFn();
        resolve(result);
    } catch (error) {
        reject(error);
    } finally {
        isProcessing = false;
        setTimeout(processQueue, 1000); 
    }
}

// --- GROQ ADAPTER ---
// This safely handles both Text and Image prompts using Groq FREE API, 
// while mimicking the old Gemini response structure so existing routes do not break!
async function generateSafe(input) {
    const maxRetries = 5; 
    const baseDelay = 3000; 
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            let messages = [
                { role: "system", content: "You are a professional AI chef. You must ALWAYS return a valid JSON object. Do not use markdown blocks." }
            ];
            
            let promptText = "";
            let base64Image = null;

            // Handle the old array format used in vision routes
            if (Array.isArray(input)) {
                promptText = input[0];
                base64Image = input[1].inlineData.data;
            } else {
                promptText = input;
            }

            if (base64Image) {
                messages.push({
                    role: "user",
                    content: [
                        { type: "text", text: promptText },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                    ]
                });
            } else {
                messages.push({ role: "user", content: promptText });
            }

            // Select Groq Llama 3 models based on input type
            const targetModel = base64Image ? "llama-3.2-11b-vision-preview" : "llama-3.3-70b-versatile";

            const response = await openai.chat.completions.create({
                model: targetModel,
                messages: messages,
                temperature: 0.5
            });

            const jsonOutput = response.choices[0].message.content;

            // Return the exact structure the old extractJSON function expects
            return {
                response: {
                    text: () => jsonOutput
                }
            };

        } catch (error) {
            const isRateLimit = error.status === 429 || error.status === 503 || (error.message && error.message.includes('Rate'));
            if (isRateLimit && i < maxRetries - 1) {
                console.log(`[AI Queue] Rate limit hit. Retrying in ${baseDelay * Math.pow(2, i)}ms...`);
                await new Promise(resolve => setTimeout(resolve, baseDelay * Math.pow(2, i)));
                continue;
            }
            throw error; 
        }
    }
    throw new Error("AI is busy or error occurred.");
}

// --- HELPER FUNCTION: EXTRACT JSON ---
// This function forcefully extracts JSON from AI's text, ignoring all markdown or chatty text.
function extractJSON(text) {
    try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        throw new Error("No JSON object found in text");
    } catch (e) {
        console.error("--- AI JSON PARSE FAILED ---");
        console.error("Raw AI Text:", text);
        throw e;
    }
}

// ==========================================
// --- PAGE ROUTES (Frontend) ---
// ==========================================

app.get('/', async (req, res) => {
    try {
        const userDoc = await db.collection('user_settings').doc('current_user').get();
        const settings = userDoc.exists ? userDoc.data() : { equipment: [], allergies: [], healthGoal: "" };
        
        const equipStr = Array.isArray(settings.equipment) ? settings.equipment.join(", ") : (settings.equipment || "");
        const allergyStr = Array.isArray(settings.allergies) ? settings.allergies.join(", ") : (settings.allergies || "");

        const formattedSettings = {
            equipment: equipStr,
            userAllergies: allergyStr,
            healthGoal: settings.healthGoal || ""
        };
        
        const suggestions = [
            { name: "Quinoa Salad", calories: 220, benefit: "High Protein", ingredients: ["Quinoa", "Cucumber"] },
            { name: "Grilled Salmon", calories: 350, benefit: "Omega-3 Rich", ingredients: ["Salmon", "Lemon"] },
            { name: "Avocado Toast", calories: 180, benefit: "Healthy Fats", ingredients: ["Bread", "Avocado"] }
        ];
        res.render('index', { suggestions: suggestions, settings: formattedSettings });
    } catch (e) {
        res.render('index', { suggestions: [], settings: { equipment: "", userAllergies: "", healthGoal: "" } });
    }
});

app.get('/calculator', (req, res) => {
    res.render('calculator', { result: null, foodName: null });
});

app.post('/calculate', (req, res) => {
    const { foodName, grams } = req.body;
    let caloriesPer100g = 100;
    if (foodName.toLowerCase().includes("chicken")) caloriesPer100g = 165;
    else if (foodName.toLowerCase().includes("rice")) caloriesPer100g = 130;
    
    const total = Math.floor((grams * caloriesPer100g) / 100);
    res.render('calculator', { result: total, foodName: foodName });
});

app.get('/ai-cooking', (req, res) => {
    res.render('ai-cooking');
});

// ==========================================
// --- LEGACY API ROUTES ---
// ==========================================

app.post('/api/set-cooking-info', async (req, res) => {
    const { dishName, equipment, healthGoal, allergies } = req.body;
    try {
        await db.collection('user_settings').doc('current_user').set({ 
            lastRequestedDish: dishName || "",
            equipment: equipment ? equipment.split(',').map(i => i.trim()) : [], 
            allergies: allergies ? allergies.split(',').map(i => i.trim()) : [],
            healthGoal: healthGoal || "",
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        res.json({ status: "success", message: "Settings saved to Cloud!" });
    } catch (e) {
        res.status(500).json({ status: "error" });
    }
});

app.post('/api/analyze-frame', async (req, res) => {
    const { image } = req.body;
    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
    const imagePart = { inlineData: { data: base64Data, mimeType: "image/jpeg" } };
    
    const prompt = `Look at this food image. Identify the raw ingredients visible (vegetables, meats, fruits). 
    Return ONLY a raw JSON object like this: { "ingredients": ["Item 1", "Item 2"] }`;

    try {
        const result = await executeWithQueue(() => generateSafe([prompt, imagePart]));
        const data = extractJSON(result.response.text());
        res.json({ status: "success", ingredients: data.ingredients || [], instruction: "Ingredients Detected!" });
    } catch (error) {
        console.error("Analyze Frame Error:", error.message);
        res.status(500).json({ status: "error", message: "Failed to analyze image" });
    }
});

app.post('/api/generate-recipe-from-ingredients', async (req, res) => {
    const { ingredients } = req.body;
    try {
        const userDoc = await db.collection('user_settings').doc('current_user').get();
        const settings = userDoc.exists ? userDoc.data() : { equipment: [], healthGoal: "Healthy" };

        const prompt = `
        Create a healthy recipe using: ${ingredients.join(", ")}.
        User Equipment: ${(settings.equipment || []).join(", ") || "Standard Kitchen"}.
        User Goal: ${settings.healthGoal || "Healthy"}.
        Return ONLY raw JSON in exactly this format:
        { "title": "Recipe Name", "calories": 500, "steps": ["Step 1...", "Step 2..."] }
        `;

        const result = await executeWithQueue(() => generateSafe(prompt));
        const recipe = extractJSON(result.response.text());
        
        await db.collection('history').add({
            recipe: recipe,
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ status: "success", recipe: recipe });
    } catch (error) {
        console.error("Generate From Ingredients Error:", error.message);
        res.status(500).json({ status: "error" });
    }
});

app.post('/api/generate-recipe-direct', async (req, res) => {
    const { dishName, equipment, healthGoal, allergies } = req.body;
    try {
        await db.collection('user_settings').doc('current_user').set({
            lastRequestedDish: dishName,
            equipment: equipment ? equipment.split(',').map(i => i.trim()) : [], 
            allergies: allergies ? allergies.split(',').map(i => i.trim()) : [],
            healthGoal: healthGoal,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        const prompt = `
        You are a professional AI Chef. 
        User wants to cook: ${dishName}. 
        Equipment available: ${equipment}. 
        Health Goal: ${healthGoal}.
        Allergies/Dislikes to avoid: ${allergies || "None"}. DO NOT use these ingredients.
        Provide a structured recipe. Return ONLY raw JSON in this EXACT format:
        {
            "title": "Recipe Title",
            "calories": 450,
            "macros": "High Protein",
            "ingredients": ["Item 1", "Item 2"],
            "steps": ["Step 1...", "Step 2..."],
            "chef_note": "Useful tip for beginners"
        }`;

        const result = await executeWithQueue(() => generateSafe(prompt));
        const recipe = extractJSON(result.response.text());
        
        await db.collection('history').add({
            recipe: recipe,
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, recipe: recipe });
    } catch (error) {
        console.error("Generate Direct Error:", error.message);
        res.json({ success: false, error: "AI generation failed. Please try again." });
    }
});

app.get('/api/database', async (req, res) => {
    try {
        const snapshot = await db.collection('history').orderBy('created_at', 'desc').limit(10).get();
        const history = [];
        snapshot.forEach(doc => history.push(doc.data()));
        res.json(history);
    } catch (error) {
        res.json([]);
    }
});

// ==========================================
// --- NEW PRO UI API ROUTES ---
// ==========================================

app.post('/api/save-settings', async (req, res) => {
    const { equipment, allergies } = req.body;
    try {
        await db.collection('user_settings').doc('current_user').set({
            equipment: equipment || [],
            allergies: allergies || [],
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        res.json({ success: true });
    } catch (error) { 
        res.status(500).json({ error: "Save failed" }); 
    }
});

app.get('/api/get-settings', async (req, res) => {
    try {
        const doc = await db.collection('user_settings').doc('current_user').get();
        if (doc.exists) res.json({ success: true, settings: doc.data() });
        else res.json({ success: true, settings: { equipment: [], allergies: [] } });
    } catch (error) { 
        res.status(500).json({ error: "Fetch failed" }); 
    }
});

app.get('/api/get-history', async (req, res) => {
    try {
        const snapshot = await db.collection('history').orderBy('created_at', 'asc').get();
        const history = [];
        snapshot.forEach(doc => history.push({ id: doc.id, content: doc.data().recipe }));
        res.json({ success: true, history: history });
    } catch (error) { 
        res.status(500).json({ error: "Fetch failed" }); 
    }
});

app.delete('/api/clear-history', async (req, res) => {
    try {
        const snapshot = await db.collection('history').get();
        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        res.json({ success: true });
    } catch (error) { 
        res.status(500).json({ error: "Clear failed" }); 
    }
});

app.post('/api/analyze-fridge', async (req, res) => {
    const { imageBase64, language } = req.body;
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const imagePart = { inlineData: { data: base64Data, mimeType: "image/jpeg" } };
    
    const prompt = `Identify food ingredients. Return JSON: { "ingredients": ["item1", "item2"] }. Respond in English.`;

    try {
        const result = await executeWithQueue(() => generateSafe([prompt, imagePart]));
        const data = extractJSON(result.response.text());
        res.json({ success: true, data: data });
    } catch (error) { 
        console.error("Analyze Fridge Pro Error:", error.message);
        res.status(500).json({ error: "Vision Failed" }); 
    }
});

app.post('/api/recommend-dishes', async (req, res) => {
    const { ingredients } = req.body;
    const prompt = `
    User has ingredients: ${ingredients.join(", ")}.
    Respond in English. Recommend 3 distinct dishes using these ingredients.
    Return ONLY raw JSON format:
    { "recommendations": [ { "name": "Dish Name", "description": "Short description", "image_keywords": "photorealistic food photography of [Dish Name], 4k" } ] }`;

    try {
        const result = await executeWithQueue(() => generateSafe(prompt));
        const data = extractJSON(result.response.text());
        res.json({ success: true, data: data });
    } catch (error) { 
        console.error("Recommend Dishes Error:", error.message);
        res.status(500).json({ error: "Recommendation failed" }); 
    }
});

app.post('/api/generate-recipe', async (req, res) => {
    const { dishName, calorieLimit, fridgeIngredients } = req.body;
    try {
        const userDoc = await db.collection('user_settings').doc('current_user').get();
        const settings = userDoc.exists ? userDoc.data() : { equipment: [], allergies: [] };
        const caloriePrompt = calorieLimit ? `Strictly under ${calorieLimit} kcal.` : "Standard calories.";

        const prompt = `
        You are a professional chef AI. Respond in English.
        [Request] Dish: ${dishName}, Calorie Goal: ${caloriePrompt}, Fridge Ingredients: ${fridgeIngredients || "None"}
        [User Profile] Equipment: ${(settings.equipment || []).join(", ")}, Allergies: ${(settings.allergies || []).join(", ")}
        Return ONLY raw JSON:
        { "title": "Recipe Title", "image_keywords": "close up shot of ${dishName}, professional food photography, 8k", "calories": 500, "ingredients": ["item1"], "steps": ["step1"], "modification_note": "Explain changes" }`;

        const result = await executeWithQueue(() => generateSafe(prompt));
        const recipe = extractJSON(result.response.text());

        await db.collection('history').add({ 
            recipe: recipe, 
            created_at: admin.firestore.FieldValue.serverTimestamp() 
        });
        
        res.json({ success: true, data: recipe });
    } catch (error) { 
        console.error("Pro Generate Recipe Error:", error.message);
        res.status(500).json({ error: "AI Generation Failed" }); 
    }
});

// ==========================================
// --- NEW FEEDBACK API ROUTE ---
// ==========================================
app.post('/api/submit-feedback', async (req, res) => {
    const { rating, comments, latency } = req.body;
    try {
        await db.collection('feedback').add({
            rating: parseInt(rating) || 0,
            comments: comments || "",
            latency: latency || 0,
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true, message: "Feedback saved successfully!" });
    } catch (error) {
        console.error("Feedback Error:", error.message);
        res.status(500).json({ error: "Failed to save feedback" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});