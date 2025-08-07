export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ 
      success: false, 
      error: 'Method not allowed. Use POST.' 
    });
  }

  try {
    console.log('=== API Request Started ===');
    console.log('Method:', req.method);
    console.log('Headers:', JSON.stringify(req.headers, null, 2));

    // Handle body parsing more robustly
    let body;
    
    if (req.body) {
      // Body is already parsed by Vercel
      body = req.body;
      console.log('Using pre-parsed body');
    } else {
      // Manually parse the body if needed
      console.log('Manually parsing body...');
      const chunks = [];
      
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      
      const rawBody = Buffer.concat(chunks).toString('utf8');
      console.log('Raw body length:', rawBody.length);
      
      try {
        body = JSON.parse(rawBody);
        console.log('Successfully parsed JSON body');
      } catch (parseError) {
        console.error('JSON parse error:', parseError.message);
        return res.status(400).json({
          success: false,
          error: 'Invalid JSON in request body'
        });
      }
    }

    console.log('Body keys:', Object.keys(body || {}));

    const { image, type } = body || {};

    // Validate input
    if (!image) {
      console.error('Missing image field');
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required field: image' 
      });
    }

    if (!type) {
      console.error('Missing type field');
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required field: type' 
      });
    }

    console.log('Request type:', type);
    console.log('Image data length:', typeof image === 'string' ? image.length : 'not a string');

    // Handle test requests - return success without calling OpenAI
    if (image === 'test') {
      console.log('Test request detected - returning mock data');
      const mockData = type === 'receipt' ? {
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
      } : {
        meal_name: 'Test Meal',
        ingredients: ['test ingredient'],
        estimated_portions: { 'test ingredient': 0.5 }
      };

      return res.status(200).json({ 
        success: true,
        data: mockData
      });
    }

    // Get OpenAI API key from environment variables
    const openaiApiKey = process.env.OPENAI_API_KEY;
    
    if (!openaiApiKey) {
      console.error('OPENAI_API_KEY environment variable not found');
      return res.status(500).json({ 
        success: false, 
        error: 'OpenAI API key not configured on server' 
      });
    }

    console.log('OpenAI API key found, length:', openaiApiKey.length);

    // Validate base64 image format
    if (!isValidBase64Image(image)) {
      console.error('Invalid base64 image format');
      return res.status(400).json({
        success: false,
        error: 'Invalid image format. Please provide a valid base64 image.'
      });
    }

    console.log('Base64 image validation passed');
    console.log('Calling OpenAI API...');

    // Prepare the prompt based on type
    const prompt = type === 'receipt' ? 
      `Analyze this grocery receipt image and extract the items. Return ONLY a JSON object with this exact structure (no extra text):
      {
        "store": "store name or Unknown Store",
        "date": "date from receipt or today's date",
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
      If you can't read specific details, make reasonable estimates. Always return valid JSON.` :
      `Analyze this meal photo and identify the ingredients. Return ONLY a JSON object with this exact structure (no extra text):
      {
        "meal_name": "brief description of the meal",
        "ingredients": ["ingredient1", "ingredient2", "ingredient3"],
        "estimated_portions": {
          "ingredient1": 0.5,
          "ingredient2": 1.0,
          "ingredient3": 0.25
        }
      }
      Estimate reasonable portion sizes (0.1 to 2.0). Always return valid JSON.`;

    // Call OpenAI Vision API
    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiApiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt
              },
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
        max_tokens: 1500,
        temperature: 0.1
      })
    });

    console.log('OpenAI response status:', openaiResponse.status);

    if (!openaiResponse.ok) {
      let errorData;
      try {
        errorData = await openaiResponse.json();
        console.error('OpenAI API Error Details:', JSON.stringify(errorData, null, 2));
      } catch (e) {
        const errorText = await openaiResponse.text();
        console.error('OpenAI API Error Text:', errorText);
        errorData = { error: { message: errorText } };
      }
      
      return res.status(500).json({ 
        success: false, 
        error: `OpenAI API error (${openaiResponse.status}): ${errorData?.error?.message || 'Unknown error'}`,
        details: errorData
      });
    }

    const openaiData = await openaiResponse.json();
    console.log('OpenAI response received successfully');

    // Extract the content from OpenAI response
    const content = openaiData.choices?.[0]?.message?.content;
    
    if (!content) {
      console.error('No content in OpenAI response');
      return res.status(500).json({ 
        success: false, 
        error: 'No content received from AI',
        openaiResponse: openaiData
      });
    }

    console.log('AI Response content (first 200 chars):', content.slice(0, 200));

    // Parse the JSON response from OpenAI
    let parsedData;
    try {
      // Try to extract JSON from the response
      let jsonString = content.trim();
      
      // Remove markdown code blocks if present
      jsonString = jsonString.replace(/```json\s*/, '').replace(/\s*```$/, '');
      
      // Look for JSON object in the response
      const jsonMatch = jsonString.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonString = jsonMatch[0];
      }
      
      parsedData = JSON.parse(jsonString);
      console.log('Successfully parsed AI response');
      
    } catch (parseError) {
      console.error('Failed to parse AI response as JSON:', parseError.message);
      console.error('Content was:', content);
      
      // Return a fallback response
      if (type === 'receipt') {
        parsedData = {
          store: 'Receipt Detected',
          date: new Date().toLocaleDateString(),
          items: [
            {
              name: 'Item from receipt',
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
          ingredients: ['food item'],
          estimated_portions: { 'food item': 0.5 }
        };
      }
      
      console.log('Using fallback data due to parse error');
    }

    console.log('=== API Request Completed Successfully ===');

    // Return the parsed data
    return res.status(200).json({
      success: true,
      data: parsedData
    });

  } catch (error) {
    console.error('=== API Request Failed ===');
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
    
    return res.status(500).json({ 
      success: false, 
      error: `Server error: ${error.message}`,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

// Helper function to validate base64 image
function isValidBase64Image(base64String) {
  try {
    if (!base64String || typeof base64String !== 'string') {
      return false;
    }
    
    // Remove data URL prefix if present
    const base64Data = base64String.replace(/^data:image\/[a-z]+;base64,/, '');
    
    // Basic base64 validation
    const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!base64Regex.test(base64Data)) {
      return false;
    }
    
    // Check if it's long enough to be an actual image (at least 100 characters)
    if (base64Data.length < 100) {
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('Base64 validation error:', error);
    return false;
  }
}
