// api/analyze.js - Vercel Serverless Function
export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image, type } = req.body;

  if (!image || !type) {
    return res.status(400).json({ error: 'Missing image or type parameter' });
  }

  // Your API key is safely stored as an environment variable
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: 'OpenAI API key not configured' });
  }

  const prompt = type === 'receipt' ? 
    `Look at this grocery receipt image and extract the items. For packaged items, use typical package contents rather than just "1". Return ONLY a valid JSON object:

{
  "store": "store name or Unknown",
  "date": "today's date",
  "items": [
    {
      "name": "item name",
      "quantity": 8,
      "unit": "slices",
      "price": 2.99,
      "category": "Bakery"
    }
  ],
  "total": 2.99
}

IMPORTANT - Use these typical package contents for common items:
- Bread/Sandwich Bread: 20-24 slices per loaf
- Hot Dog/Hamburger Buns: 8 buns per package
- Bagels: 6 bagels per package
- English Muffins: 6 muffins per package
- Yogurt Cups: 4-6 cups per pack
- Eggs: 12 eggs per dozen
- Chicken Breasts: 2-4 pieces per package
- Ground Meat: Use actual weight in lbs
- Cheese Slices: 12-16 slices per package
- Tortillas: 8-10 tortillas per package
- Cereal: 1 box (but specify as "box")
- Pasta: 1 box/bag (but specify as "box")
- Soup Cans: Count individual cans
- Soda/Water: Count individual bottles/cans
- Toilet Paper: Count individual rolls (usually 4-24 per pack)
- Paper Towels: Count individual rolls
- Bananas: Count individual bananas
- Apples: Count individual apples or use lbs
- Milk: 1 gallon/quart/pint as shown

Valid categories: Produce, Dairy, Meat, Pantry, Household, Bakery, Frozen
Make sure quantities reflect actual usable units (slices, pieces, individual items).` :
    
    `Look at this meal image and identify the main ingredients. Return ONLY a valid JSON object:

{
  "meal_name": "dish name",
  "ingredients": ["ingredient1", "ingredient2"],
  "estimated_portions": {
    "ingredient1": 0.5,
    "ingredient2": 1.0
  }
}

Focus on ingredients that would be in a grocery inventory.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: { 
                  url: `data:image/jpeg;base64,${image}`,
                  detail: 'low'
                }
              }
            ]
          }
        ],
        max_tokens: 500,
        temperature: 0.1
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API Error:', response.status, errorText);
      return res.status(500).json({ 
        error: `OpenAI API error: ${response.status}`,
        details: errorText 
      });
    }

    const data = await response.json();
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      return res.status(500).json({ error: 'Invalid response from OpenAI' });
    }
    
    let content = data.choices[0].message.content.trim();
    
    // Clean up the response
    content = content.replace(/```json\s*/g, '').replace(/```\s*/g, '');
    content = content.replace(/^[^{]*({.*})[^}]*$/s, '$1');
    
    try {
      const parsedData = JSON.parse(content);
      
      // Validate the response structure
      if (type === 'receipt') {
        if (!parsedData.items || !Array.isArray(parsedData.items)) {
          throw new Error('Invalid receipt format: missing items array');
        }
      } else {
        if (!parsedData.ingredients || !Array.isArray(parsedData.ingredients)) {
          throw new Error('Invalid meal format: missing ingredients array');
        }
      }
      
      return res.status(200).json({
        success: true,
        data: parsedData
      });
      
    } catch (parseError) {
      console.error('JSON Parse Error:', parseError);
      return res.status(500).json({ 
        error: 'Failed to parse AI response',
        details: content
      });
    }
    
  } catch (error) {
    console.error('Function Error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
}
