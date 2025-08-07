export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { image, type } = req.body;

    // Validate input
    if (!image || !type) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: image and type' 
      });
    }

    // Handle test requests - return success without calling OpenAI
    if (image === 'test') {
      console.log('Test request received - returning mock success');
      return res.status(200).json({ 
        success: true,
        data: {
          store: 'Test Store',
          date: new Date().toLocaleDateString(),
          items: [
            {
              name: 'Test Item',
              quantity: 1,
              unit: 'piece',
              price: 1.00,
              category: 'Test'
            }
          ],
          total: 1.00
        }
      });
    }

    // Get OpenAI API key from environment variables
    const openaiApiKey = process.env.OPENAI_API_KEY;
    
    if (!openaiApiKey) {
      console.error('OPENAI_API_KEY not found in environment variables');
      return res.status(500).json({ 
        success: false, 
        error: 'OpenAI API key not configured' 
      });
    }

    console.log('Processing', type, 'analysis request');

    // Validate base64 image format
    if (!isValidBase64Image(image)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid image format. Please provide a valid base64 image.'
      });
    }

    // Call OpenAI Vision API
    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // Use the newer, faster model
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: type === 'receipt' ? 
                  `Analyze this grocery receipt and extract items. Return ONLY a JSON object with this exact structure:
                  {
                    "store": "store name",
                    "date": "date from receipt",
                    "items": [
                      {
                        "name": "item name",
                        "quantity": number,
                        "unit": "pieces/lbs/gallons/etc",
                        "price": number,
                        "category": "Produce/Dairy/Meat/Bakery/Pantry/Household/etc"
                      }
                    ],
                    "total": number
                  }
                  Estimate reasonable quantities if not clear. Use common sense for units and categories.` :
                  `Analyze this meal photo and identify ingredients. Return ONLY a JSON object with this exact structure:
                  {
                    "meal_name": "description of the meal",
                    "ingredients": ["ingredient1", "ingredient2", "ingredient3"],
                    "estimated_portions": {
                      "ingredient1": 0.5,
                      "ingredient2": 1.0,
                      "ingredient3": 0.25
                    }
                  }
                  Estimate reasonable portion sizes consumed (0.1 to 2.0 scale).`
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${image}`,
                  detail: 'low' // Use low detail for faster/cheaper processing
                }
              }
            ]
          }
        ],
        max_tokens: 1000,
        temperature: 0.1
      })
    });

    if (!openaiResponse.ok) {
      let errorData;
      try {
        errorData = await openaiResponse.json();
        console.error('OpenAI API Error:', openaiResponse.status, errorData);
      } catch (e) {
        const errorText = await openaiResponse.text();
        console.error('OpenAI API Error:', openaiResponse.status, errorText);
        errorData = { error: { message: errorText } };
      }
      
      return res.status(500).json({ 
        success: false, 
        error: `OpenAI API error: ${openaiResponse.status}`,
        details: JSON.stringify(errorData)
      });
    }

    const openaiData = await openaiResponse.json();
    console.log('OpenAI response received successfully');

    // Extract the content from OpenAI response
    const content = openaiData.choices[0]?.message?.content;
    
    if (!content) {
      console.error('No content in OpenAI response:', openaiData);
      return res.status(500).json({ 
        success: false, 
        error: 'No content received from AI' 
      });
    }

    // Parse the JSON response from OpenAI
    let parsedData;
    try {
      // Clean up the response in case there's extra text
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const jsonString = jsonMatch ? jsonMatch[0] : content;
      parsedData = JSON.parse(jsonString);
    } catch (parseError) {
      console.error('Failed to parse AI response as JSON:', content);
      // Return a fallback response instead of failing completely
      if (type === 'receipt') {
        parsedData = {
          store: 'Unknown Store',
          date: new Date().toLocaleDateString(),
          items: [
            {
              name: 'Receipt Item',
              quantity: 1,
              unit: 'item',
              price: 0.00,
              category: 'Unknown'
            }
          ],
          total: 0.00
        };
      } else {
        parsedData = {
          meal_name: 'Meal from photo',
          ingredients: ['unknown'],
          estimated_portions: { 'unknown': 0.5 }
        };
      }
    }

    console.log('Analysis successful');

    // Return the parsed data
    return res.status(200).json({
      success: true,
      data: parsedData
    });

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ 
      success: false, 
      error: error.message || 'Internal server error' 
    });
  }
}

// Helper function to validate base64 image
function isValidBase64Image(base64String) {
  try {
    // Check if it's a valid base64 string
    if (!base64String || typeof base64String !== 'string') {
      return false;
    }
    
    // Basic base64 validation
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!base64Regex.test(base64String)) {
      return false;
    }
    
    // Check if it's long enough to be an actual image (at least 100 characters)
    if (base64String.length < 100) {
      return false;
    }
    
    return true;
  } catch (error) {
    return false;
  }
}
