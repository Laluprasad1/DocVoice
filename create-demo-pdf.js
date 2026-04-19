const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Create a PDF document
const doc = new PDFDocument();

// Create output file
const outputPath = path.join(__dirname, 'public', 'sample.pdf');
const stream = fs.createWriteStream(outputPath);

doc.pipe(stream);

// Add content
doc.fontSize(24).text('The Art of Reading', 100, 100);
doc.fontSize(12).moveDown();

doc.fontSize(14).text('Chapter 1: Getting Started', { underline: true });
doc.fontSize(11).moveDown();

doc.text(
  'Reading is one of the most important skills a person can develop. ' +
  'It opens up new worlds, expands our vocabulary, and improves our comprehension. ' +
  'Whether you are reading for pleasure or for educational purposes, the benefits are immense. ' +
  'In this chapter, we will explore the fundamentals of effective reading techniques.',
  { align: 'left', width: 400 }
);

doc.moveDown();
doc.fontSize(14).text('The Importance of Daily Reading', { underline: true });
doc.fontSize(11).moveDown();

doc.text(
  'Daily reading habits can significantly improve your mental health and cognitive abilities. ' +
  'When you read regularly, your brain strengthens its neural pathways, improving memory retention ' +
  'and recall. Studies have shown that people who read daily have better focus, reduced stress levels, ' +
  'and enhanced critical thinking skills. Make reading a part of your daily routine, even if it is ' +
  'just for fifteen minutes before bedtime.',
  { align: 'left', width: 400 }
);

doc.addPage();

doc.fontSize(14).text('Building a Reading Habit', { underline: true });
doc.fontSize(11).moveDown();

doc.text(
  'To build a strong reading habit, start with books or articles that interest you. ' +
  'Do not force yourself to read something you dislike. Find a comfortable, quiet place to read ' +
  'where you can concentrate without distractions. Set a specific time each day for reading, ' +
  'whether it is in the morning with your coffee or in the evening before bed. ' +
  'Keep track of the books you have read and rate them to help yourself choose future reading materials.',
  { align: 'left', width: 400 }
);

doc.moveDown();
doc.fontSize(14).text('Different Reading Techniques', { underline: true });
doc.fontSize(11).moveDown();

doc.text(
  'There are various reading techniques you can employ to improve comprehension and speed. ' +
  'Skimming is a technique where you quickly scan the text to get an overview of the content. ' +
  'Scanning involves looking for specific information within the text. Deep reading, on the other hand, ' +
  'requires you to engage fully with the material, taking notes and questioning the content. ' +
  'Choose the technique that best suits your purpose for reading.',
  { align: 'left', width: 400 }
);

doc.addPage();

doc.fontSize(14).text('Conclusion', { underline: true });
doc.fontSize(11).moveDown();

doc.text(
  'Reading is a powerful tool for personal growth and development. By making reading a daily habit ' +
  'and employing the right techniques, you can significantly enhance your knowledge and skills. ' +
  'Remember, the goal is not to read the most books in the shortest time, but to truly understand ' +
  'and absorb the material. Happy reading!',
  { align: 'left', width: 400 }
);

doc.end();

stream.on('finish', () => {
  console.log('✓ Demo PDF created successfully!');
  console.log(`📄 File saved to: ${outputPath}`);
  console.log('\n📖 You can now upload this PDF to the application!');
});

stream.on('error', (err) => {
  console.error('Error creating PDF:', err);
});
